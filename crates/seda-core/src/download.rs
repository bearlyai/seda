use crate::{Catalog, Error, Paths, PreparedModel, Result, RuntimeArchive, RuntimeSpec};
use futures_util::StreamExt;
use reqwest::header::RANGE;
use seda_protocol::Profile;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadProgress {
    pub id: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallEvent {
    Resolving,
    Downloading(DownloadProgress),
    Verifying { id: String },
    Installing { id: String },
    Ready { id: String },
}

type Reporter = Arc<dyn Fn(InstallEvent) + Send + Sync>;

#[derive(Clone)]
pub struct Installer {
    paths: Paths,
    catalog: Catalog,
    client: reqwest::Client,
}

impl Installer {
    /// Creates an installer using the supplied data paths and catalog.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP client cannot be initialized.
    pub fn new(paths: Paths, catalog: Catalog) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("seda/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|source| Error::Download {
                url: "client initialization".to_owned(),
                source,
            })?;
        Ok(Self {
            paths,
            catalog,
            client,
        })
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Installs and verifies the runtime and realtime model for one profile.
    ///
    /// # Errors
    ///
    /// Returns an error for unsupported platforms, failed downloads, checksum
    /// mismatches, unsafe archives, or filesystem failures.
    pub async fn prepare<F>(
        &self,
        profile: Profile,
        language: &str,
        report: F,
    ) -> Result<PreparedModel>
    where
        F: Fn(InstallEvent) + Send + Sync + 'static,
    {
        let report: Reporter = Arc::new(report);
        report(InstallEvent::Resolving);
        self.paths.ensure().await?;

        let model = self
            .catalog
            .resolve_model(profile, language, crate::ModelPurpose::Realtime)?
            .clone();
        let (runtime, archive) = self.catalog.resolve_runtime(&model.runtime)?;
        let runtime = runtime.clone();
        let archive = archive.clone();

        let runtime_dir = self
            .ensure_runtime(&runtime, &archive, Arc::clone(&report))
            .await?;
        let model_path = self.paths.model_file(&model.id, &model.file_name);
        self.ensure_download(
            &model.id,
            &model.url,
            &model.sha256,
            model.size,
            &model_path,
            Arc::clone(&report),
        )
        .await?;

        let library_path = runtime
            .library_names
            .iter()
            .map(|name| runtime_dir.join(name))
            .find(|path| path.is_file())
            .ok_or_else(|| {
                Error::Runtime(format!(
                    "runtime archive did not contain any of: {}",
                    runtime.library_names.join(", ")
                ))
            })?;

        report(InstallEvent::Ready {
            id: model.id.clone(),
        });

        Ok(PreparedModel {
            runtime,
            runtime_archive: archive,
            runtime_dir,
            library_path,
            model,
            model_path,
        })
    }

    async fn ensure_runtime(
        &self,
        runtime: &RuntimeSpec,
        archive: &RuntimeArchive,
        report: Reporter,
    ) -> Result<PathBuf> {
        let destination = self.paths.runtime_dir(runtime, archive);
        if runtime
            .library_names
            .iter()
            .any(|name| destination.join(name).is_file())
        {
            return Ok(destination);
        }

        let archive_name = archive
            .url
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::Runtime(format!("invalid runtime URL: {}", archive.url)))?;
        let archive_path = self.paths.downloads().join(archive_name);
        let id = format!("{}-{}", runtime.id, runtime.version);
        self.ensure_download(
            &id,
            &archive.url,
            &archive.sha256,
            archive.size,
            &archive_path,
            Arc::clone(&report),
        )
        .await?;

        report(InstallEvent::Installing { id: id.clone() });
        remove_existing_path(&destination).await?;
        let archive_path_for_task = archive_path.clone();
        let destination_for_task = destination.clone();
        tokio::task::spawn_blocking(move || {
            extract_archive(&archive_path_for_task, &destination_for_task)
        })
        .await
        .map_err(|error| Error::Runtime(format!("runtime installer task failed: {error}")))??;
        report(InstallEvent::Ready { id });
        Ok(destination)
    }

    #[allow(clippy::too_many_lines)]
    async fn ensure_download(
        &self,
        id: &str,
        url: &str,
        expected_sha256: &str,
        total_bytes: u64,
        destination: &Path,
        report: Reporter,
    ) -> Result<()> {
        if destination.is_file() {
            report(InstallEvent::Verifying { id: id.to_owned() });
            if sha256(destination).await? == expected_sha256 {
                return Ok(());
            }
            remove_existing_path(destination).await?;
        }

        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| Error::io(parent, error))?;
        }

        let part = destination.with_extension(format!(
            "{}.part",
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        ));
        if part.is_file() {
            report(InstallEvent::Verifying { id: id.to_owned() });
            if sha256(&part).await? == expected_sha256 {
                tokio::fs::rename(&part, destination)
                    .await
                    .map_err(|error| Error::io(destination, error))?;
                return Ok(());
            }
        }
        let mut existing = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if existing >= total_bytes {
            remove_existing_path(&part).await?;
            existing = 0;
        }

        let mut request = self.client.get(url);
        if existing > 0 {
            request = request.header(RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().await.map_err(|source| Error::Download {
            url: url.to_owned(),
            source,
        })?;
        let status = response.status();
        if !(status.is_success()) {
            return Err(Error::DownloadStatus {
                url: url.to_owned(),
                status,
            });
        }

        let resumed = existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        let mut completed = if resumed { existing } else { 0 };
        let mut last_reported = completed;
        let mut file = if resumed {
            tokio::fs::OpenOptions::new().append(true).open(&part).await
        } else {
            tokio::fs::File::create(&part).await
        }
        .map_err(|error| Error::io(&part, error))?;

        report(InstallEvent::Downloading(DownloadProgress {
            id: id.to_owned(),
            completed_bytes: completed,
            total_bytes,
        }));

        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|source| Error::Download {
                url: url.to_owned(),
                source,
            })?;
            file.write_all(&chunk)
                .await
                .map_err(|error| Error::io(&part, error))?;
            completed = completed.saturating_add(chunk.len() as u64);
            if completed == total_bytes || completed.saturating_sub(last_reported) >= 1024 * 1024 {
                report(InstallEvent::Downloading(DownloadProgress {
                    id: id.to_owned(),
                    completed_bytes: completed,
                    total_bytes,
                }));
                last_reported = completed;
            }
        }
        file.flush()
            .await
            .map_err(|error| Error::io(&part, error))?;
        drop(file);

        report(InstallEvent::Verifying { id: id.to_owned() });
        let actual = sha256(&part).await?;
        if actual != expected_sha256 {
            remove_existing_path(&part).await?;
            return Err(Error::Checksum {
                path: part,
                expected: expected_sha256.to_owned(),
                actual,
            });
        }
        tokio::fs::rename(&part, destination)
            .await
            .map_err(|error| Error::io(destination, error))?;
        Ok(())
    }
}

async fn sha256(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| Error::io(path, error))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| Error::io(path, error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

async fn remove_existing_path(path: &Path) -> Result<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(Error::io(path, error)),
    };
    if metadata.file_type().is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    }
    .map_err(|error| Error::io(path, error))
}

fn extract_archive(archive_path: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| Error::UnsafeArchive(archive_path.to_owned()))?;
    std::fs::create_dir_all(parent).map_err(|error| Error::io(parent, error))?;
    let temporary = tempfile::Builder::new()
        .prefix(".seda-runtime-")
        .tempdir_in(parent)
        .map_err(|error| Error::io(parent, error))?;
    let unpacked = temporary.path().join("unpacked");
    std::fs::create_dir(&unpacked).map_err(|error| Error::io(&unpacked, error))?;

    let name = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.ends_with(".tar.gz") {
        extract_tar_gz(archive_path, &unpacked)?;
    } else if Path::new(&name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        extract_zip(archive_path, &unpacked)?;
    } else {
        return Err(Error::UnknownArchive(archive_path.to_owned()));
    }

    let mut entries = std::fs::read_dir(&unpacked)
        .map_err(|error| Error::io(&unpacked, error))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| Error::io(&unpacked, error))?;
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Err(Error::UnsafeArchive(archive_path.to_owned()));
    }
    let top = entries.swap_remove(0).path();
    std::fs::rename(&top, destination).map_err(|error| Error::io(destination, error))?;
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<()> {
    let file = std::fs::File::open(archive_path).map_err(|error| Error::io(archive_path, error))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|error| Error::io(destination, error))
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<()> {
    let file = std::fs::File::open(archive_path).map_err(|error| Error::io(archive_path, error))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| Error::Runtime(error.to_string()))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| Error::Runtime(error.to_string()))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| Error::UnsafeArchive(archive_path.to_owned()))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| Error::io(&output, error))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| Error::io(parent, error))?;
        }
        let mut output_file =
            std::fs::File::create(&output).map_err(|error| Error::io(&output, error))?;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|error| Error::io(archive_path, error))?;
            if read == 0 {
                break;
            }
            output_file
                .write_all(&buffer[..read])
                .map_err(|error| Error::io(&output, error))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sha256;
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn hashes_files_without_loading_them_whole() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("data");
        tokio::fs::write(&path, b"seda")
            .await
            .expect("fixture writes");
        let expected = hex::encode(Sha256::digest(b"seda"));
        assert_eq!(sha256(&path).await.expect("hash succeeds"), expected);
    }
}

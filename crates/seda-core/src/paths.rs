use crate::{Error, Result};
use directories::ProjectDirs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// Discovers Seda's per-user data directory.
    ///
    /// `SEDA_HOME` overrides the platform-native location.
    ///
    /// # Errors
    ///
    /// Returns an error when no application data directory can be resolved.
    pub fn discover() -> Result<Self> {
        if let Some(root) = std::env::var_os("SEDA_HOME") {
            return Ok(Self::new(root));
        }

        let project = ProjectDirs::from("ai", "Bearly", "Seda").ok_or_else(|| {
            Error::Runtime("could not resolve the user data directory".to_owned())
        })?;
        Ok(Self::new(project.data_local_dir()))
    }

    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn downloads(&self) -> PathBuf {
        self.root.join("downloads")
    }

    pub fn models(&self) -> PathBuf {
        self.root.join("models")
    }

    pub fn runtimes(&self) -> PathBuf {
        self.root.join("runtimes")
    }

    pub fn model_file(&self, model_id: &str, file_name: &str) -> PathBuf {
        self.models().join(model_id).join(file_name)
    }

    pub fn runtime_dir(&self, runtime: &RuntimeSpec, archive: &RuntimeArchive) -> PathBuf {
        self.runtimes()
            .join(&runtime.id)
            .join(&runtime.version)
            .join(format!(
                "{}-{}-{}",
                archive.os, archive.arch, archive.accelerator
            ))
    }

    /// Creates all managed data directories.
    ///
    /// # Errors
    ///
    /// Returns an error when a directory cannot be created.
    pub async fn ensure(&self) -> Result<()> {
        for path in [self.downloads(), self.models(), self.runtimes()] {
            tokio::fs::create_dir_all(&path)
                .await
                .map_err(|error| Error::io(path, error))?;
        }
        Ok(())
    }
}

use crate::{RuntimeArchive, RuntimeSpec};

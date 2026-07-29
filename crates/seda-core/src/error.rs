use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Seda does not have a runtime build for {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },

    #[error("no realtime model matches `{selector}`")]
    ModelUnavailable { selector: String },

    #[error("model `{0}` is not installed")]
    ModelNotReady(String),

    #[error("language `{requested}` is not supported; choose one of {supported}")]
    UnsupportedLanguage {
        requested: String,
        supported: String,
    },

    #[error("invalid embedded catalog: {0}")]
    InvalidCatalog(#[from] serde_json::Error),

    #[error("download failed for {url}: {source}")]
    Download {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    #[error("download returned HTTP {status} for {url}")]
    DownloadStatus {
        url: String,
        status: reqwest::StatusCode,
    },

    #[error("checksum mismatch for {path}: expected {expected}, received {actual}")]
    Checksum {
        path: PathBuf,
        expected: String,
        actual: String,
    },

    #[error("archive `{0}` has no safe top-level directory")]
    UnsafeArchive(PathBuf),

    #[error("invalid runtime archive format for `{0}`")]
    UnknownArchive(PathBuf),

    #[error("I/O failure at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("runtime failed: {0}")]
    Runtime(String),

    #[error("invalid audio: {0}")]
    InvalidAudio(String),
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

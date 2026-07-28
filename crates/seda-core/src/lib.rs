//! Runtime-independent model management and recognition engine contracts.

mod catalog;
mod download;
mod engine;
mod error;
mod paths;

pub use catalog::{Catalog, ModelPurpose, ModelSpec, PreparedModel, RuntimeArchive, RuntimeSpec};
pub use download::{DownloadProgress, InstallEvent, Installer};
pub use engine::{EngineEvent, EngineMetadata, RecognitionEngine, RecognitionSession};
pub use error::{Error, Result};
pub use paths::Paths;

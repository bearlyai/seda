use crate::{Error, Paths, Result};
use seda_protocol::{LanguageMode, ModelIdentity, Profile, StreamingKind};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CATALOG_JSON: &str = include_str!("../../../models/catalog.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u16,
    pub runtimes: Vec<RuntimeSpec>,
    pub models: Vec<ModelSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpec {
    pub id: String,
    pub version: String,
    pub abi: u16,
    pub license: String,
    pub source: String,
    pub library_names: Vec<String>,
    pub archives: Vec<RuntimeArchive>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArchive {
    pub os: String,
    pub arch: String,
    pub accelerator: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct ModelSpec {
    pub id: String,
    pub revision: String,
    pub variant: String,
    #[serde(default)]
    pub default_variant: bool,
    pub display_name: String,
    pub runtime: String,
    pub profiles: Vec<Profile>,
    pub purpose: ModelPurpose,
    pub languages: Vec<String>,
    pub language_mode: LanguageMode,
    pub supports_auto: bool,
    pub streaming: StreamingKind,
    pub punctuation: bool,
    pub word_timestamps: bool,
    pub quantization: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub file_name: String,
    pub license: String,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPurpose {
    Realtime,
    Refine,
}

#[derive(Debug, Clone)]
pub struct PreparedModel {
    pub runtime: RuntimeSpec,
    pub runtime_archive: RuntimeArchive,
    pub runtime_dir: PathBuf,
    pub library_path: PathBuf,
    pub model: ModelSpec,
    pub model_path: PathBuf,
}

impl Catalog {
    /// Loads the catalog compiled into the Seda binary.
    ///
    /// # Errors
    ///
    /// Returns an error when the embedded JSON does not match the catalog schema.
    pub fn embedded() -> Result<Self> {
        serde_json::from_str(CATALOG_JSON).map_err(Error::from)
    }

    /// Selects a concrete model ID and optional variant.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ModelUnavailable`] when no catalog entry matches.
    pub fn resolve_model_id(
        &self,
        model_id: &str,
        variant: Option<&str>,
        purpose: ModelPurpose,
    ) -> Result<&ModelSpec> {
        self.models
            .iter()
            .find(|model| {
                model.id == model_id
                    && model.purpose == purpose
                    && variant.map_or(model.default_variant, |value| model.variant == value)
            })
            .ok_or_else(|| Error::ModelUnavailable {
                selector: variant.map_or_else(
                    || model_id.to_owned(),
                    |value| format!("{model_id}#{value}"),
                ),
            })
    }

    /// Resolves a hardware-aware convenience profile.
    ///
    /// Profiles are aliases only; callers should expose the returned concrete
    /// model identity.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ModelUnavailable`] when the profile has no model.
    pub fn resolve_profile(&self, profile: Profile, purpose: ModelPurpose) -> Result<&ModelSpec> {
        self.models
            .iter()
            .find(|model| model.profiles.contains(&profile) && model.purpose == purpose)
            .ok_or_else(|| Error::ModelUnavailable {
                selector: format!("profile:{profile}"),
            })
    }

    /// Selects the runtime archive for the current platform.
    ///
    /// # Errors
    ///
    /// Returns an error for an unknown runtime or unsupported platform.
    pub fn resolve_runtime(&self, runtime_id: &str) -> Result<(&RuntimeSpec, &RuntimeArchive)> {
        let runtime = self
            .runtimes
            .iter()
            .find(|runtime| runtime.id == runtime_id)
            .ok_or_else(|| Error::Runtime(format!("unknown runtime `{runtime_id}`")))?;

        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        let preferred = preferred_accelerator(os, arch);
        let archive = runtime
            .archives
            .iter()
            .find(|archive| {
                archive.os == os && archive.arch == arch && archive.accelerator == preferred
            })
            .or_else(|| {
                runtime.archives.iter().find(|archive| {
                    archive.os == os && archive.arch == arch && archive.accelerator == "cpu"
                })
            })
            .ok_or_else(|| Error::UnsupportedPlatform {
                os: os.to_owned(),
                arch: arch.to_owned(),
            })?;

        Ok((runtime, archive))
    }

    /// Resolves paths for an already-installed model and runtime.
    ///
    /// # Errors
    ///
    /// Returns an error when the platform is unsupported or an artifact is missing.
    pub fn prepared(
        &self,
        paths: &Paths,
        model_id: &str,
        variant: Option<&str>,
    ) -> Result<PreparedModel> {
        let model = self
            .resolve_model_id(model_id, variant, ModelPurpose::Realtime)?
            .clone();
        let (runtime, archive) = self.resolve_runtime(&model.runtime)?;
        let runtime_dir = paths.runtime_dir(runtime, archive);
        let library_path = runtime
            .library_names
            .iter()
            .map(|name| runtime_dir.join(name))
            .find(|path| path.is_file())
            .ok_or_else(|| Error::ModelNotReady(format!("runtime {}", runtime.id)))?;
        let model_path = paths.model_file(&model.id, &model.file_name);
        if !model_path.is_file() {
            return Err(Error::ModelNotReady(model.id));
        }

        Ok(PreparedModel {
            runtime: runtime.clone(),
            runtime_archive: archive.clone(),
            runtime_dir,
            library_path,
            model,
            model_path,
        })
    }
}

impl ModelSpec {
    #[must_use]
    pub fn identity(&self) -> ModelIdentity {
        ModelIdentity {
            id: self.id.clone(),
            revision: self.revision.clone(),
            variant: self.variant.clone(),
            runtime: self.runtime.clone(),
        }
    }
}

fn preferred_accelerator(os: &str, arch: &str) -> &'static str {
    if let Ok(value) = std::env::var("SEDA_ACCELERATOR") {
        return match value.as_str() {
            "metal" => "metal",
            "vulkan" => "vulkan",
            "cuda" => "cuda",
            _ => "cpu",
        };
    }

    match (os, arch) {
        ("macos", "aarch64") => "metal",
        _ => "cpu",
    }
}

#[cfg(test)]
mod tests {
    use super::{Catalog, ModelPurpose};
    use seda_protocol::Profile;

    #[test]
    fn compact_resolves_to_small_streaming_model() {
        let catalog = Catalog::embedded().expect("catalog parses");
        let model = catalog
            .resolve_profile(Profile::Compact, ModelPurpose::Realtime)
            .expect("model resolves");
        assert_eq!(model.id, "nvidia/parakeet_realtime_eou_120m-v1");
        assert_eq!(model.variant, "q4_k");
    }

    #[test]
    fn exact_model_id_can_choose_a_variant() {
        let catalog = Catalog::embedded().expect("catalog parses");
        let model = catalog
            .resolve_model_id(
                "nvidia/nemotron-3.5-asr-streaming-0.6b",
                Some("q8_0"),
                ModelPurpose::Realtime,
            )
            .expect("model resolves");
        assert_eq!(model.variant, "q8_0");
    }

    #[test]
    fn exact_model_id_uses_its_default_variant() {
        let catalog = Catalog::embedded().expect("catalog parses");
        let model = catalog
            .resolve_model_id(
                "nvidia/nemotron-3.5-asr-streaming-0.6b",
                None,
                ModelPurpose::Realtime,
            )
            .expect("model resolves");
        assert_eq!(model.variant, "q4_k");
    }
}

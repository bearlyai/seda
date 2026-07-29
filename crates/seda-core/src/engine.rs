use crate::Result;
use seda_protocol::{LanguageMode, ModelIdentity, StreamingKind, Transcript, Word};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineMetadata {
    pub runtime: String,
    /// Deprecated compatibility field. Use `resolved_model.id`.
    pub model: String,
    pub resolved_model: ModelIdentity,
    pub language_mode: LanguageMode,
    pub supports_auto_language: bool,
    pub languages: Vec<String>,
    pub streaming: StreamingKind,
    pub punctuation: bool,
    pub word_timestamps: bool,
}

impl EngineMetadata {
    /// Resolves an optional stream language against this resident model.
    ///
    /// Omission selects automatic detection when supported, otherwise the
    /// model's single fixed language. Explicit `auto` is accepted only when
    /// the runtime advertises it.
    ///
    /// # Errors
    ///
    /// Returns [`crate::Error::UnsupportedLanguage`] when a prompt is required
    /// or the requested language is unsupported.
    pub fn resolve_language(&self, requested: Option<&str>) -> Result<String> {
        let requested = requested.filter(|language| !language.is_empty());
        let Some(requested) = requested else {
            if self.supports_auto_language {
                return Ok("auto".to_owned());
            }
            if self.languages.len() == 1 {
                return Ok(self.languages[0].clone());
            }
            return Err(crate::Error::UnsupportedLanguage {
                requested: "<required>".to_owned(),
                supported: self.languages.join(", "),
            });
        };
        if requested == "auto" {
            return self
                .supports_auto_language
                .then(|| requested.to_owned())
                .ok_or_else(|| crate::Error::UnsupportedLanguage {
                    requested: requested.to_owned(),
                    supported: self.languages.join(", "),
                });
        }
        let matches = self.languages.iter().any(|language| {
            language.eq_ignore_ascii_case(requested)
                || requested
                    .split_once('-')
                    .is_some_and(|(base, _)| language.eq_ignore_ascii_case(base))
                || language
                    .split_once('-')
                    .is_some_and(|(base, _)| base.eq_ignore_ascii_case(requested))
        });
        matches
            .then(|| requested.to_owned())
            .ok_or_else(|| crate::Error::UnsupportedLanguage {
                requested: requested.to_owned(),
                supported: self.languages.join(", "),
            })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Text { text: String, words: Vec<Word> },
    EndOfUtterance { at_ms: u64 },
    Backchannel { at_ms: u64 },
}

/// A loaded model. Implementations must keep model state reusable across sessions.
pub trait RecognitionEngine: Send + Sync {
    fn metadata(&self) -> &EngineMetadata;

    /// Transcribes a complete waveform.
    ///
    /// # Errors
    ///
    /// Returns an error when the audio or requested language is unsupported,
    /// or when the underlying runtime fails.
    fn transcribe(&self, pcm: &[f32], sample_rate: u32, language: &str) -> Result<Transcript>;

    /// Opens one independent live recognition stream.
    ///
    /// # Errors
    ///
    /// Returns an error when the language is unsupported or the runtime cannot
    /// allocate a new stream.
    fn start_session(&self, language: &str) -> Result<Box<dyn RecognitionSession>>;
}

/// One live stream. A session is owned by one request and never shared.
pub trait RecognitionSession: Send {
    /// Feeds one chunk of 16 kHz mono floating-point PCM.
    ///
    /// # Errors
    ///
    /// Returns an error when the session is closed or inference fails.
    fn feed(&mut self, pcm_16khz_mono: &[f32]) -> Result<Vec<EngineEvent>>;

    /// Flushes the stream and returns any terminal events.
    ///
    /// # Errors
    ///
    /// Returns an error when finalization fails.
    fn commit(&mut self) -> Result<Vec<EngineEvent>>;
}

#[cfg(test)]
mod tests {
    use super::EngineMetadata;
    use seda_protocol::{LanguageMode, ModelIdentity, StreamingKind};

    fn metadata(mode: LanguageMode, languages: &[&str], supports_auto: bool) -> EngineMetadata {
        EngineMetadata {
            runtime: "fixture".to_owned(),
            model: "fixture/model".to_owned(),
            resolved_model: ModelIdentity {
                id: "fixture/model".to_owned(),
                revision: "test".to_owned(),
                variant: "fixture".to_owned(),
                runtime: "fixture".to_owned(),
            },
            language_mode: mode,
            supports_auto_language: supports_auto,
            languages: languages.iter().map(ToString::to_string).collect(),
            streaming: StreamingKind::True,
            punctuation: true,
            word_timestamps: false,
        }
    }

    #[test]
    fn omitted_language_uses_a_fixed_models_language() {
        let model = metadata(LanguageMode::Fixed, &["en"], false);
        assert_eq!(
            model.resolve_language(None).expect("language resolves"),
            "en"
        );
        assert!(model.resolve_language(Some("auto")).is_err());
    }

    #[test]
    fn prompted_model_changes_language_without_changing_identity() {
        let model = metadata(LanguageMode::Prompted, &["en-US", "de-DE"], true);
        assert_eq!(
            model
                .resolve_language(Some("de-DE"))
                .expect("language resolves"),
            "de-DE"
        );
        assert_eq!(model.resolve_language(None).expect("auto resolves"), "auto");
        assert_eq!(model.resolved_model.id, "fixture/model");
    }
}

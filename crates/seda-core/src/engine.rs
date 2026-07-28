use crate::Result;
use seda_protocol::{StreamingKind, Transcript, Word};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineMetadata {
    pub runtime: String,
    pub model: String,
    pub languages: Vec<String>,
    pub streaming: StreamingKind,
    pub punctuation: bool,
    pub word_timestamps: bool,
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

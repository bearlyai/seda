//! Safe, load-once adapter around the versioned `parakeet.cpp` C ABI.

use libloading::Library;
use seda_core::{
    EngineEvent, EngineMetadata, Error, ModelSpec, RecognitionEngine, RecognitionSession, Result,
};
use seda_protocol::{Transcript, Word};
use serde::Deserialize;
use std::ffi::{CStr, CString, c_char, c_float, c_int, c_void};
use std::path::Path;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, MutexGuard};

const SUPPORTED_ABI: i32 = 5;

type Context = c_void;
type Stream = c_void;

type AbiVersionFn = unsafe extern "C" fn() -> c_int;
type LoadFn = unsafe extern "C" fn(*const c_char) -> *mut Context;
type FreeFn = unsafe extern "C" fn(*mut Context);
type LastErrorFn = unsafe extern "C" fn(*mut Context) -> *const c_char;
type FreeStringFn = unsafe extern "C" fn(*mut c_char);
type TranscribePcmBatchJsonLangFn = unsafe extern "C" fn(
    *mut Context,
    *const c_float,
    *const c_int,
    c_int,
    c_int,
    c_int,
    *const c_char,
) -> *mut c_char;
type StreamBeginLangFn = unsafe extern "C" fn(*mut Context, *const c_char) -> *mut Stream;
type StreamFeedJsonFn = unsafe extern "C" fn(*mut Stream, *const c_float, c_int) -> *mut c_char;
type StreamFinalizeJsonFn = unsafe extern "C" fn(*mut Stream) -> *mut c_char;
type StreamFreeFn = unsafe extern "C" fn(*mut Stream);

struct Api {
    _library: Library,
    load: LoadFn,
    free: FreeFn,
    last_error: LastErrorFn,
    free_string: FreeStringFn,
    transcribe_pcm_batch_json_lang: TranscribePcmBatchJsonLangFn,
    stream_begin_lang: StreamBeginLangFn,
    stream_feed_json: StreamFeedJsonFn,
    stream_finalize_json: StreamFinalizeJsonFn,
    stream_free: StreamFreeFn,
}

struct LoadedModel {
    api: Arc<Api>,
    context: NonNull<Context>,
}

// SAFETY: every access to this value and its underlying parakeet context is
// serialized by `ParakeetEngine::model`. The C API documents opaque handles
// with no thread affinity and does not retain caller-owned buffers.
unsafe impl Send for LoadedModel {}

impl Drop for LoadedModel {
    fn drop(&mut self) {
        // SAFETY: this context was returned by `api.load`, is still owned here,
        // and is freed exactly once after all sessions release their Arc.
        unsafe { (self.api.free)(self.context.as_ptr()) };
    }
}

pub struct ParakeetEngine {
    metadata: EngineMetadata,
    model: Arc<Mutex<LoadedModel>>,
}

impl ParakeetEngine {
    /// Loads the pinned parakeet.cpp ABI and one model into memory.
    ///
    /// # Errors
    ///
    /// Returns an error when the library, ABI, model path, or model cannot be
    /// loaded.
    pub fn load(
        library_path: impl AsRef<Path>,
        model_path: impl AsRef<Path>,
        model_spec: &ModelSpec,
    ) -> Result<Self> {
        let api = Arc::new(load_api(library_path.as_ref())?);
        let model_path = path_to_cstring(model_path.as_ref())?;
        // SAFETY: `model_path` is a valid NUL-terminated string for the duration
        // of the call. Ownership of a successful context transfers to us.
        let context = unsafe { (api.load)(model_path.as_ptr()) };
        let context = NonNull::new(context)
            .ok_or_else(|| Error::Runtime("parakeet.cpp could not load the model".to_owned()))?;

        Ok(Self {
            metadata: EngineMetadata {
                runtime: "parakeet.cpp".to_owned(),
                model: model_spec.id.clone(),
                languages: model_spec.languages.clone(),
                streaming: model_spec.streaming.clone(),
                punctuation: model_spec.punctuation,
                word_timestamps: model_spec.word_timestamps,
            },
            model: Arc::new(Mutex::new(LoadedModel { api, context })),
        })
    }
}

impl RecognitionEngine for ParakeetEngine {
    fn metadata(&self) -> &EngineMetadata {
        &self.metadata
    }

    fn transcribe(&self, pcm: &[f32], sample_rate: u32, language: &str) -> Result<Transcript> {
        let sample_count = checked_length(pcm.len())?;
        let sample_rate = c_int::try_from(sample_rate)
            .map_err(|_| Error::InvalidAudio("sample rate exceeds C ABI range".to_owned()))?;
        let language = CString::new(language)
            .map_err(|_| Error::Runtime("language contains a NUL byte".to_owned()))?;
        let counts = [sample_count];
        let model = lock_model(&self.model)?;
        // SAFETY: all pointers refer to live, correctly sized values for this
        // synchronous call; the context is locked against concurrent access.
        let output = unsafe {
            (model.api.transcribe_pcm_batch_json_lang)(
                model.context.as_ptr(),
                pcm.as_ptr(),
                counts.as_ptr(),
                1,
                sample_rate,
                0,
                language.as_ptr(),
            )
        };
        let json =
            take_string(&model.api, output).ok_or_else(|| Error::Runtime(last_error(&model)))?;
        let mut decoded: Vec<OfflinePayload> = serde_json::from_str(&json)
            .map_err(|error| Error::Runtime(format!("invalid parakeet JSON: {error}")))?;
        let payload = decoded
            .pop()
            .ok_or_else(|| Error::Runtime("parakeet returned no transcript".to_owned()))?;
        Ok(Transcript {
            text: strip_control_tokens(&payload.text),
            words: normalize_words(payload.words),
            language: (language.to_bytes() != b"auto")
                .then(|| language.to_string_lossy().into_owned()),
            duration_ms: duration_ms(pcm.len(), sample_rate),
        })
    }

    fn start_session(&self, language: &str) -> Result<Box<dyn RecognitionSession>> {
        let language = CString::new(language)
            .map_err(|_| Error::Runtime("language contains a NUL byte".to_owned()))?;
        let model = lock_model(&self.model)?;
        // SAFETY: the model context is valid and locked, and the language
        // pointer remains valid for the synchronous call.
        let stream =
            unsafe { (model.api.stream_begin_lang)(model.context.as_ptr(), language.as_ptr()) };
        let stream = NonNull::new(stream).ok_or_else(|| Error::Runtime(last_error(&model)))?;
        drop(model);
        Ok(Box::new(ParakeetSession {
            model: Arc::clone(&self.model),
            stream,
            committed: false,
        }))
    }
}

struct ParakeetSession {
    model: Arc<Mutex<LoadedModel>>,
    stream: NonNull<Stream>,
    committed: bool,
}

// SAFETY: the session is exclusively owned, all C calls are synchronous, and
// access to the shared model context is serialized by the mutex.
unsafe impl Send for ParakeetSession {}

impl RecognitionSession for ParakeetSession {
    fn feed(&mut self, pcm_16khz_mono: &[f32]) -> Result<Vec<EngineEvent>> {
        if self.committed {
            return Err(Error::Runtime("session is already committed".to_owned()));
        }
        let sample_count = checked_length(pcm_16khz_mono.len())?;
        let model = lock_model(&self.model)?;
        // SAFETY: the stream is live and exclusively owned; PCM points to
        // `sample_count` floats for the complete synchronous call.
        let output = unsafe {
            (model.api.stream_feed_json)(
                self.stream.as_ptr(),
                pcm_16khz_mono.as_ptr(),
                sample_count,
            )
        };
        parse_stream_output(&model, output)
    }

    fn commit(&mut self) -> Result<Vec<EngineEvent>> {
        if self.committed {
            return Ok(vec![]);
        }
        let model = lock_model(&self.model)?;
        // SAFETY: the stream is live, exclusively owned, and finalized once.
        let output = unsafe { (model.api.stream_finalize_json)(self.stream.as_ptr()) };
        let events = parse_stream_output(&model, output)?;
        self.committed = true;
        Ok(events)
    }
}

impl Drop for ParakeetSession {
    fn drop(&mut self) {
        if let Ok(model) = self.model.lock() {
            // SAFETY: the stream was created by this API and is freed exactly
            // once while its parent model is still live.
            unsafe { (model.api.stream_free)(self.stream.as_ptr()) };
        }
    }
}

fn load_api(path: &Path) -> Result<Api> {
    // SAFETY: loading a user-selected dynamic library is the purpose of this
    // adapter. The installer verifies the pinned artifact checksum before this.
    let library = unsafe { Library::new(path) }
        .map_err(|error| Error::Runtime(format!("could not load {}: {error}", path.display())))?;

    // SAFETY: each requested symbol is copied as the exact signature declared
    // by parakeet_capi.h ABI v5. The library remains owned by `Api`.
    let abi_version: AbiVersionFn = unsafe { symbol(&library, b"parakeet_capi_abi_version\0")? };
    // SAFETY: function has no arguments and returns the library ABI integer.
    let abi = unsafe { abi_version() };
    if abi != SUPPORTED_ABI {
        return Err(Error::Runtime(format!(
            "unsupported parakeet.cpp ABI {abi}; expected {SUPPORTED_ABI}"
        )));
    }

    // SAFETY: signatures match the pinned ABI header.
    unsafe {
        Ok(Api {
            load: symbol(&library, b"parakeet_capi_load\0")?,
            free: symbol(&library, b"parakeet_capi_free\0")?,
            last_error: symbol(&library, b"parakeet_capi_last_error\0")?,
            free_string: symbol(&library, b"parakeet_capi_free_string\0")?,
            transcribe_pcm_batch_json_lang: symbol(
                &library,
                b"parakeet_capi_transcribe_pcm_batch_json_lang\0",
            )?,
            stream_begin_lang: symbol(&library, b"parakeet_capi_stream_begin_lang\0")?,
            stream_feed_json: symbol(&library, b"parakeet_capi_stream_feed_json\0")?,
            stream_finalize_json: symbol(&library, b"parakeet_capi_stream_finalize_json\0")?,
            stream_free: symbol(&library, b"parakeet_capi_stream_free\0")?,
            _library: library,
        })
    }
}

unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
    // SAFETY: the caller supplies the function signature associated with this
    // exact C ABI symbol, and `Api` keeps the library loaded.
    let loaded = unsafe { library.get::<T>(name) }
        .map_err(|error| Error::Runtime(format!("missing parakeet.cpp symbol: {error}")))?;
    Ok(*loaded)
}

fn lock_model(model: &Mutex<LoadedModel>) -> Result<MutexGuard<'_, LoadedModel>> {
    model
        .lock()
        .map_err(|_| Error::Runtime("parakeet model lock is poisoned".to_owned()))
}

fn take_string(api: &Api, pointer: *mut c_char) -> Option<String> {
    let pointer = NonNull::new(pointer)?;
    // SAFETY: the C API returns a valid NUL-terminated allocation.
    let value = unsafe { CStr::from_ptr(pointer.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    // SAFETY: this pointer came from the API and is released exactly once.
    unsafe { (api.free_string)(pointer.as_ptr()) };
    Some(value)
}

fn last_error(model: &LoadedModel) -> String {
    // SAFETY: the model context is live and locked for the complete call.
    let pointer = unsafe { (model.api.last_error)(model.context.as_ptr()) };
    if pointer.is_null() {
        return "unknown parakeet.cpp error".to_owned();
    }
    // SAFETY: parakeet.cpp owns a valid NUL-terminated error string.
    let message = unsafe { CStr::from_ptr(pointer) }.to_string_lossy();
    if message.is_empty() {
        "unknown parakeet.cpp error".to_owned()
    } else {
        message.into_owned()
    }
}

fn parse_stream_output(model: &LoadedModel, pointer: *mut c_char) -> Result<Vec<EngineEvent>> {
    let json = take_string(&model.api, pointer).ok_or_else(|| Error::Runtime(last_error(model)))?;
    let payload: StreamPayload = serde_json::from_str(&json)
        .map_err(|error| Error::Runtime(format!("invalid parakeet stream JSON: {error}")))?;
    let mut output = Vec::new();
    let text = strip_control_tokens(&payload.text);
    let words = normalize_words(payload.words);
    if !text.is_empty() || !words.is_empty() {
        output.push(EngineEvent::Text { text, words });
    }
    for event in payload.events {
        let at_ms = seconds_to_ms(event.at);
        match event.kind.as_str() {
            "eou" => output.push(EngineEvent::EndOfUtterance { at_ms }),
            "eob" => output.push(EngineEvent::Backchannel { at_ms }),
            _ => {}
        }
    }
    Ok(output)
}

fn checked_length(length: usize) -> Result<c_int> {
    c_int::try_from(length)
        .map_err(|_| Error::InvalidAudio("audio buffer exceeds C ABI range".to_owned()))
}

fn path_to_cstring(path: &Path) -> Result<CString> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| Error::Runtime(format!("path contains a NUL byte: {}", path.display())))
}

fn duration_ms(samples: usize, sample_rate: c_int) -> u64 {
    let Ok(sample_rate) = u64::try_from(sample_rate) else {
        return 0;
    };
    let samples = u64::try_from(samples).unwrap_or(u64::MAX);
    samples.saturating_mul(1000) / sample_rate
}

fn seconds_to_ms(seconds: f32) -> u64 {
    std::time::Duration::try_from_secs_f32(seconds)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn strip_control_tokens(value: &str) -> String {
    let mut cleaned = value.replace("<EOU>", "").replace("<EOB>", "");
    loop {
        let trimmed_length = cleaned.trim_end().len();
        let trimmed = &cleaned[..trimmed_length];
        let Some(start) = trimmed.rfind('<') else {
            break;
        };
        if !trimmed.ends_with('>') || !is_language_tag(&trimmed[start + 1..trimmed.len() - 1]) {
            break;
        }
        cleaned.truncate(start);
        cleaned.truncate(cleaned.trim_end().len());
    }
    cleaned
}

fn is_language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    let locale = parts.next();
    parts.next().is_none()
        && language.len() == 2
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && locale.is_none_or(|part| {
            part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_alphabetic())
        })
}

fn normalize_words(words: Vec<ParakeetWord>) -> Vec<Word> {
    words
        .into_iter()
        .filter_map(|word| {
            let text = strip_control_tokens(&word.text);
            (!text.is_empty()).then_some(Word {
                text,
                start_ms: seconds_to_ms(word.start),
                end_ms: seconds_to_ms(word.end),
                confidence: word.confidence,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct OfflinePayload {
    text: String,
    #[serde(default)]
    words: Vec<ParakeetWord>,
}

#[derive(Debug, Deserialize)]
struct StreamPayload {
    text: String,
    #[serde(default)]
    words: Vec<ParakeetWord>,
    #[serde(default)]
    events: Vec<ParakeetEvent>,
}

#[derive(Debug, Deserialize)]
struct ParakeetWord {
    #[serde(rename = "w")]
    text: String,
    start: f32,
    end: f32,
    #[serde(rename = "conf")]
    confidence: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ParakeetEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "t")]
    at: f32,
}

#[cfg(test)]
mod tests {
    use super::{ParakeetWord, normalize_words, strip_control_tokens};

    #[test]
    fn removes_model_control_tokens_from_public_transcripts() {
        assert_eq!(strip_control_tokens("hello<EOU>"), "hello");
        assert_eq!(strip_control_tokens("hello. <en-US>"), "hello.");
        let words = normalize_words(vec![ParakeetWord {
            text: "portrait<EOU>".to_owned(),
            start: 1.0,
            end: 1.5,
            confidence: Some(0.9),
        }]);
        assert_eq!(words[0].text, "portrait");
    }
}

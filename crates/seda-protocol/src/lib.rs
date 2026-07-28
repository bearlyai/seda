//! Stable, runtime-independent types used by every Seda transport.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The current wire protocol major version.
pub const PROTOCOL_VERSION: u16 = 1;

/// Hardware-aware intent used to select a model.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Compact,
    #[default]
    Balanced,
    Quality,
}

impl fmt::Display for Profile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Compact => "compact",
            Self::Balanced => "balanced",
            Self::Quality => "quality",
        })
    }
}

impl std::str::FromStr for Profile {
    type Err = ParseProfileError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "compact" => Ok(Self::Compact),
            "balanced" => Ok(Self::Balanced),
            "quality" => Ok(Self::Quality),
            _ => Err(ParseProfileError(value.to_owned())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown profile `{0}`; expected compact, balanced, or quality")]
pub struct ParseProfileError(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamingKind {
    True,
    Buffered,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub name: String,
    pub version: String,
    pub protocol: u16,
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// These are independent wire capabilities, not mutually exclusive states.
#[allow(clippy::struct_excessive_bools)]
pub struct Capabilities {
    pub runtime: String,
    pub model: String,
    pub languages: Vec<String>,
    pub streaming: StreamingKind,
    pub punctuation: bool,
    pub word_timestamps: bool,
    pub global_push_to_talk: bool,
    pub focused_app_insertion: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<Word>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub input: AudioFormat,
}

fn default_language() -> String {
    "auto".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormat {
    pub encoding: AudioEncoding,
    pub sample_rate: u32,
    pub channels: u8,
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self {
            encoding: AudioEncoding::PcmS16Le,
            sample_rate: 16_000,
            channels: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioEncoding {
    #[serde(rename = "pcm_s16le")]
    PcmS16Le,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreated {
    pub id: String,
    pub websocket_path: String,
    pub ticket: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Commit,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerEvent {
    Ready {
        session_id: String,
    },
    Transcript {
        segment_id: String,
        revision: u64,
        text: String,
        stable_text: String,
        unstable_text: String,
        #[serde(rename = "final")]
        final_: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        words: Vec<Word>,
    },
    EndOfUtterance {
        at_ms: u64,
    },
    Backchannel {
        at_ms: u64,
    },
    Completed {
        transcript: Transcript,
    },
    Cancelled,
    Error {
        error: ErrorBody,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PermissionDenied,
    ModelNotReady,
    DownloadRequired,
    DownloadFailed,
    UnsupportedHardware,
    InvalidAudio,
    AudioDeviceUnavailable,
    AudioDeviceLost,
    SessionBusy,
    InvalidRequest,
    Unauthorized,
    OriginDenied,
    Cancelled,
    RuntimeFailed,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[cfg(test)]
mod tests {
    use super::{Profile, ServerEvent};

    #[test]
    fn protocol_serializes_with_stable_event_names() {
        let event = ServerEvent::Transcript {
            segment_id: "segment-1".to_owned(),
            revision: 2,
            text: "hello".to_owned(),
            stable_text: "hello".to_owned(),
            unstable_text: String::new(),
            final_: true,
            words: vec![],
        };

        let value = serde_json::to_value(event).expect("event serializes");
        assert_eq!(value["type"], "transcript");
        assert_eq!(value["final"], true);
    }

    #[test]
    fn profile_has_intentional_default() {
        assert_eq!(Profile::default(), Profile::Balanced);
        assert_eq!("compact".parse::<Profile>(), Ok(Profile::Compact));
    }
}

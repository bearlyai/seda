//! Authenticated loopback service exposing Seda's stable protocol.

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use http::Method;
use seda_core::{EngineEvent, Error as CoreError, RecognitionEngine};
use seda_protocol::{
    AudioEncoding, Capabilities, ClientMessage, ErrorBody, ErrorCode, ErrorResponse,
    PROTOCOL_VERSION, ServerEvent, SessionCreated, SessionRequest, Status, Transcript,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

const SESSION_TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_PENDING_SESSIONS: usize = 64;
const MAX_SESSION_SAMPLES: usize = 16_000 * 60 * 10;
const MAX_WS_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct ServerState {
    engine: Arc<dyn RecognitionEngine>,
    token: Arc<str>,
    allowed_origins: Arc<[String]>,
    pending: Arc<Mutex<HashMap<String, PendingSession>>>,
}

struct PendingSession {
    ticket: String,
    request: SessionRequest,
    created_at: Instant,
}

impl ServerState {
    /// Creates state for one loaded recognition engine.
    ///
    /// # Errors
    ///
    /// Returns an error when the bearer token is too short.
    pub fn new(
        engine: Arc<dyn RecognitionEngine>,
        token: impl Into<String>,
        allowed_origins: Vec<String>,
    ) -> Result<Self, ApiError> {
        let token = token.into();
        if token.len() < 24 {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::Internal,
                "server token must contain at least 24 characters",
                false,
            ));
        }
        Ok(Self {
            engine,
            token: Arc::from(token),
            allowed_origins: Arc::from(allowed_origins),
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

pub fn app(state: ServerState) -> Router {
    let allowed_origins = state
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect::<Vec<_>>();
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let protected = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/transcriptions", post(transcribe))
        .route("/v1/sessions", post(create_session))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));

    Router::new()
        .merge(protected)
        .route("/v1/sessions/{id}/stream", get(upgrade_session))
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024))
        .layer(cors)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::new(
            header::HeaderName::from_static("x-request-id"),
            MakeRequestUuid,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

async fn authenticate(
    State(state): State<ServerState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let matches: bool = provided.as_bytes().ct_eq(state.token.as_bytes()).into();
    if !matches {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthorized,
            "invalid or missing bearer token",
            false,
        )
        .into_response();
    }
    next.run(request).await
}

async fn status(State(_state): State<ServerState>) -> Json<Status> {
    Json(Status {
        name: "seda".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol: PROTOCOL_VERSION,
        ready: true,
    })
}

async fn capabilities(State(state): State<ServerState>) -> Json<Capabilities> {
    let metadata = state.engine.metadata();
    Json(Capabilities {
        runtime: metadata.runtime.clone(),
        model: metadata.model.clone(),
        languages: metadata.languages.clone(),
        streaming: metadata.streaming.clone(),
        punctuation: metadata.punctuation,
        word_timestamps: metadata.word_timestamps,
        global_push_to_talk: false,
        focused_app_insertion: false,
    })
}

#[derive(Debug, Deserialize)]
struct TranscriptionQuery {
    #[serde(default = "default_language")]
    language: String,
}

fn default_language() -> String {
    "auto".to_owned()
}

async fn transcribe(
    State(state): State<ServerState>,
    Query(query): Query<TranscriptionQuery>,
    body: Bytes,
) -> Result<Json<Transcript>, ApiError> {
    validate_language(&state.engine.metadata().languages, &query.language)?;
    let (pcm, sample_rate) = decode_wav(&body)?;
    let engine = Arc::clone(&state.engine);
    let transcript =
        tokio::task::spawn_blocking(move || engine.transcribe(&pcm, sample_rate, &query.language))
            .await
            .map_err(|error| ApiError::internal(format!("transcription worker failed: {error}")))?
            .map_err(ApiError::from)?;
    Ok(Json(transcript))
}

async fn create_session(
    State(state): State<ServerState>,
    Json(request): Json<SessionRequest>,
) -> Result<(StatusCode, Json<SessionCreated>), ApiError> {
    validate_session_request(&request)?;
    validate_language(&state.engine.metadata().languages, &request.language)?;
    let id = Uuid::new_v4().to_string();
    let ticket = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| ApiError::internal("session registry is unavailable"))?;
    let now = Instant::now();
    pending.retain(|_, item| now.duration_since(item.created_at) < SESSION_TICKET_TTL);
    if pending.len() >= MAX_PENDING_SESSIONS {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::SessionBusy,
            "too many pending sessions",
            true,
        ));
    }
    pending.insert(
        id.clone(),
        PendingSession {
            ticket: ticket.clone(),
            request,
            created_at: now,
        },
    );
    Ok((
        StatusCode::CREATED,
        Json(SessionCreated {
            websocket_path: format!("/v1/sessions/{id}/stream"),
            id,
            ticket,
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct TicketQuery {
    ticket: String,
}

async fn upgrade_session(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<TicketQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    validate_origin(&state, &headers)?;
    let pending = {
        let mut sessions = state
            .pending
            .lock()
            .map_err(|_| ApiError::internal("session registry is unavailable"))?;
        let pending = sessions.remove(&id).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ErrorCode::InvalidRequest,
                "session ticket is invalid or expired",
                false,
            )
        })?;
        let matches: bool = query
            .ticket
            .as_bytes()
            .ct_eq(pending.ticket.as_bytes())
            .into();
        if !matches || pending.created_at.elapsed() >= SESSION_TICKET_TTL {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                ErrorCode::Unauthorized,
                "session ticket is invalid or expired",
                false,
            ));
        }
        pending
    };
    Ok(upgrade
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| run_socket(socket, id, state.engine, pending.request))
        .into_response())
}

fn validate_origin(state: &ServerState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin.to_str().map_err(|_| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            ErrorCode::OriginDenied,
            "invalid Origin header",
            false,
        )
    })?;
    if state
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            ErrorCode::OriginDenied,
            "browser origin is not allowed",
            false,
        ))
    }
}

fn validate_session_request(request: &SessionRequest) -> Result<(), ApiError> {
    if request.input.encoding != AudioEncoding::PcmS16Le
        || request.input.sample_rate != 16_000
        || request.input.channels != 1
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidAudio,
            "live sessions require 16 kHz mono pcm_s16le audio",
            true,
        ));
    }
    Ok(())
}

fn validate_language(supported: &[String], requested: &str) -> Result<(), ApiError> {
    if requested.is_empty() || requested.len() > 32 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidRequest,
            "language must contain 1 to 32 characters",
            true,
        ));
    }
    let matches = requested == "auto"
        || supported.iter().any(|language| {
            language == requested
                || requested
                    .split_once('-')
                    .is_some_and(|(base, _)| language == base)
                || language
                    .split_once('-')
                    .is_some_and(|(base, _)| base == requested)
        });
    if !matches {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidRequest,
            format!("language `{requested}` is not supported by the active model"),
            true,
        ));
    }
    Ok(())
}

enum EngineCommand {
    Audio(Vec<f32>),
    Commit,
    Cancel,
}

enum ActorOutput {
    Events(Vec<EngineEvent>),
    Completed(Transcript),
    Cancelled,
    Failed(String),
}

#[allow(clippy::too_many_lines)]
async fn run_socket(
    socket: WebSocket,
    id: String,
    engine: Arc<dyn RecognitionEngine>,
    request: SessionRequest,
) {
    let (mut sender, mut receiver) = socket.split();
    if send_event(
        &mut sender,
        &ServerEvent::Ready {
            session_id: id.clone(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let (command_tx, command_rx) = mpsc::channel::<EngineCommand>(32);
    let (output_tx, mut output_rx) = mpsc::channel::<ActorOutput>(32);
    let actor_language = request.language.clone();
    tokio::task::spawn_blocking(move || {
        run_engine_actor(engine.as_ref(), actor_language, command_rx, &output_tx);
    });

    let mut text = String::new();
    let mut words = Vec::new();
    let mut revision = 0_u64;

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(incoming) = incoming else {
                    let _ = command_tx.send(EngineCommand::Cancel).await;
                    break;
                };
                match incoming {
                    Ok(Message::Binary(bytes)) => {
                        if bytes.len() > MAX_WS_FRAME_BYTES || bytes.len() % 2 != 0 {
                            let _ = send_protocol_error(
                                &mut sender,
                                ErrorCode::InvalidAudio,
                                "audio frames must be even-length pcm_s16le and at most 64 KiB",
                            ).await;
                            let _ = command_tx.send(EngineCommand::Cancel).await;
                            break;
                        }
                        let pcm = pcm_s16le_to_f32(&bytes);
                        if command_tx.send(EngineCommand::Audio(pcm)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Text(message)) => {
                        let Ok(control) = serde_json::from_str::<ClientMessage>(&message) else {
                            let _ = send_protocol_error(
                                &mut sender,
                                ErrorCode::InvalidRequest,
                                "invalid session control message",
                            ).await;
                            continue;
                        };
                        match control {
                            ClientMessage::Commit => {
                                if command_tx.send(EngineCommand::Commit).await.is_err() {
                                    break;
                                }
                            }
                            ClientMessage::Cancel => {
                                let _ = command_tx.send(EngineCommand::Cancel).await;
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        let _ = command_tx.send(EngineCommand::Cancel).await;
                        break;
                    }
                    Ok(Message::Ping(payload)) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Pong(_)) => {}
                }
            }
            output = output_rx.recv() => {
                let Some(output) = output else {
                    break;
                };
                match output {
                    ActorOutput::Events(events) => {
                        for event in events {
                            match event {
                                EngineEvent::Text { text: delta, words: new_words } => {
                                    text.push_str(&delta);
                                    words.extend(new_words);
                                    revision += 1;
                                    let update = ServerEvent::Transcript {
                                        segment_id: "segment-1".to_owned(),
                                        revision,
                                        text: text.clone(),
                                        stable_text: text.clone(),
                                        unstable_text: String::new(),
                                        final_: false,
                                        words: words.clone(),
                                    };
                                    if send_event(&mut sender, &update).await.is_err() {
                                        return;
                                    }
                                }
                                EngineEvent::EndOfUtterance { at_ms } => {
                                    if send_event(&mut sender, &ServerEvent::EndOfUtterance { at_ms }).await.is_err() {
                                        return;
                                    }
                                }
                                EngineEvent::Backchannel { at_ms } => {
                                    if send_event(&mut sender, &ServerEvent::Backchannel { at_ms }).await.is_err() {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    ActorOutput::Completed(mut transcript) => {
                        transcript.text.clone_from(&text);
                        transcript.words.clone_from(&words);
                        revision += 1;
                        let final_update = ServerEvent::Transcript {
                            segment_id: "segment-1".to_owned(),
                            revision,
                            text: text.clone(),
                            stable_text: text.clone(),
                            unstable_text: String::new(),
                            final_: true,
                            words: words.clone(),
                        };
                        if send_event(&mut sender, &final_update).await.is_err() {
                            return;
                        }
                        let _ = send_event(&mut sender, &ServerEvent::Completed { transcript }).await;
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                    ActorOutput::Cancelled => {
                        let _ = send_event(&mut sender, &ServerEvent::Cancelled).await;
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                    ActorOutput::Failed(message) => {
                        let _ = send_protocol_error(&mut sender, ErrorCode::RuntimeFailed, &message).await;
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }
}

fn run_engine_actor(
    engine: &dyn RecognitionEngine,
    language: String,
    mut commands: mpsc::Receiver<EngineCommand>,
    output: &mpsc::Sender<ActorOutput>,
) {
    let mut session = match engine.start_session(&language) {
        Ok(session) => session,
        Err(error) => {
            let _ = output.blocking_send(ActorOutput::Failed(error.to_string()));
            return;
        }
    };
    let mut samples = 0_usize;
    while let Some(command) = commands.blocking_recv() {
        match command {
            EngineCommand::Audio(pcm) => {
                samples = samples.saturating_add(pcm.len());
                if samples > MAX_SESSION_SAMPLES {
                    let _ = output.blocking_send(ActorOutput::Failed(
                        "session exceeded the 10 minute limit".to_owned(),
                    ));
                    return;
                }
                match session.feed(&pcm) {
                    Ok(events) if !events.is_empty() => {
                        if output.blocking_send(ActorOutput::Events(events)).is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = output.blocking_send(ActorOutput::Failed(error.to_string()));
                        return;
                    }
                }
            }
            EngineCommand::Commit => {
                match session.commit() {
                    Ok(events) if !events.is_empty() => {
                        if output.blocking_send(ActorOutput::Events(events)).is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = output.blocking_send(ActorOutput::Failed(error.to_string()));
                        return;
                    }
                }
                let transcript = Transcript {
                    text: String::new(),
                    words: vec![],
                    language: (language != "auto").then_some(language),
                    duration_ms: sample_duration_ms(samples, 16_000),
                };
                let _ = output.blocking_send(ActorOutput::Completed(transcript));
                return;
            }
            EngineCommand::Cancel => {
                let _ = output.blocking_send(ActorOutput::Cancelled);
                return;
            }
        }
    }
}

async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &ServerEvent,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(event).expect("protocol events serialize");
    sender.send(Message::Text(json.into())).await
}

async fn send_protocol_error(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: ErrorCode,
    message: &str,
) -> Result<(), axum::Error> {
    send_event(
        sender,
        &ServerEvent::Error {
            error: ErrorBody {
                code,
                message: message.to_owned(),
                recoverable: false,
            },
        },
    )
    .await
}

fn pcm_s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|sample| f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0)
        .collect()
}

fn sample_duration_ms(samples: usize, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    let samples = u64::try_from(samples).unwrap_or(u64::MAX);
    samples.saturating_mul(1000) / u64::from(sample_rate)
}

fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32), ApiError> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidAudio,
            format!("invalid WAV file: {error}"),
            true,
        )
    })?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidAudio,
            "WAV input must contain one channel",
            true,
        ));
    }
    let pcm = match spec.sample_format {
        hound::SampleFormat::Int if spec.bits_per_sample == 16 => reader
            .samples::<i16>()
            .map(|sample| {
                sample
                    .map(|value| f32::from(value) / 32_768.0)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>(),
        hound::SampleFormat::Float if spec.bits_per_sample == 32 => reader
            .samples::<f32>()
            .map(|sample| sample.map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>(),
        _ => {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ErrorCode::InvalidAudio,
                "WAV input must use 16-bit integer or 32-bit float PCM",
                true,
            ));
        }
    }
    .map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::InvalidAudio,
            format!("could not decode WAV samples: {error}"),
            true,
        )
    })?;
    Ok((pcm, spec.sample_rate))
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorResponse,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.body.error.message)
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    fn new(
        status: StatusCode,
        code: ErrorCode,
        message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            status,
            body: ErrorResponse {
                error: ErrorBody {
                    code,
                    message: message.into(),
                    recoverable,
                },
            },
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Internal,
            message,
            false,
        )
    }
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        let (status, code, recoverable) = match error {
            CoreError::InvalidAudio(_) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                ErrorCode::InvalidAudio,
                true,
            ),
            CoreError::ModelNotReady(_) => (StatusCode::CONFLICT, ErrorCode::ModelNotReady, true),
            CoreError::UnsupportedPlatform { .. } => (
                StatusCode::UNPROCESSABLE_ENTITY,
                ErrorCode::UnsupportedHardware,
                false,
            ),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::RuntimeFailed,
                false,
            ),
        };
        Self::new(status, code, error.to_string(), recoverable)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[cfg(feature = "test-engine")]
pub mod test_engine {
    use super::sample_duration_ms;
    use seda_core::{EngineEvent, EngineMetadata, RecognitionEngine, RecognitionSession, Result};
    use seda_protocol::{StreamingKind, Transcript, Word};

    pub struct FixtureEngine {
        metadata: EngineMetadata,
    }

    impl Default for FixtureEngine {
        fn default() -> Self {
            Self {
                metadata: EngineMetadata {
                    runtime: "fixture".to_owned(),
                    model: "fixture-streaming-en".to_owned(),
                    languages: vec!["en".to_owned()],
                    streaming: StreamingKind::True,
                    punctuation: true,
                    word_timestamps: true,
                },
            }
        }
    }

    impl RecognitionEngine for FixtureEngine {
        fn metadata(&self) -> &EngineMetadata {
            &self.metadata
        }

        fn transcribe(&self, pcm: &[f32], sample_rate: u32, language: &str) -> Result<Transcript> {
            Ok(Transcript {
                text: "hello world".to_owned(),
                words: fixture_words(),
                language: Some(language.to_owned()),
                duration_ms: sample_duration_ms(pcm.len(), sample_rate),
            })
        }

        fn start_session(&self, _language: &str) -> Result<Box<dyn RecognitionSession>> {
            Ok(Box::new(FixtureSession { feeds: 0 }))
        }
    }

    struct FixtureSession {
        feeds: usize,
    }

    impl RecognitionSession for FixtureSession {
        fn feed(&mut self, pcm_16khz_mono: &[f32]) -> Result<Vec<EngineEvent>> {
            if pcm_16khz_mono.is_empty() {
                return Ok(vec![]);
            }
            self.feeds += 1;
            let event = match self.feeds {
                1 => EngineEvent::Text {
                    text: "hello".to_owned(),
                    words: fixture_words()[..1].to_vec(),
                },
                2 => EngineEvent::Text {
                    text: " world".to_owned(),
                    words: fixture_words()[1..].to_vec(),
                },
                _ => return Ok(vec![]),
            };
            Ok(vec![event])
        }

        fn commit(&mut self) -> Result<Vec<EngineEvent>> {
            Ok(vec![])
        }
    }

    fn fixture_words() -> Vec<Word> {
        vec![
            Word {
                text: "hello".to_owned(),
                start_ms: 0,
                end_ms: 250,
                confidence: Some(0.99),
            },
            Word {
                text: "world".to_owned(),
                start_ms: 250,
                end_ms: 500,
                confidence: Some(0.98),
            },
        ]
    }
}

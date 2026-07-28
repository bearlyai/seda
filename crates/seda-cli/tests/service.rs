#![cfg(feature = "test-engine")]

use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use seda_protocol::{ServerEvent, SessionCreated};
use seda_server::test_engine::FixtureEngine;
use seda_server::{ServerState, app};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-token-with-more-than-24-characters";

async fn spawn_server() -> std::net::SocketAddr {
    let state =
        ServerState::new(Arc::new(FixtureEngine::default()), TOKEN, vec![]).expect("valid state");
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener binds");
    let address = listener.local_addr().expect("listener has address");
    tokio::spawn(async move {
        axum::serve(listener, app(state))
            .await
            .expect("test server runs");
    });
    address
}

#[tokio::test]
async fn protects_every_control_plane_endpoint() {
    let address = spawn_server().await;
    let response = reqwest::get(format!("http://{address}/v1/status"))
        .await
        .expect("request succeeds");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = reqwest::Client::new()
        .get(format!("http://{address}/v1/status"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .expect("authenticated request succeeds");
    assert_eq!(response.status(), StatusCode::OK);
    let status: seda_protocol::Status = response.json().await.expect("status is valid JSON");
    assert_eq!(status.protocol, 1);
    assert!(status.ready);
}

#[tokio::test]
async fn allows_browser_preflight_only_for_configured_origins() {
    let state = ServerState::new(
        Arc::new(FixtureEngine::default()),
        TOKEN,
        vec!["http://127.0.0.1:4173".to_owned()],
    )
    .expect("valid state");
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener binds");
    let address = listener.local_addr().expect("listener has address");
    tokio::spawn(async move {
        axum::serve(listener, app(state))
            .await
            .expect("test server runs");
    });

    let response = reqwest::Client::new()
        .request(
            reqwest::Method::OPTIONS,
            format!("http://{address}/v1/status"),
        )
        .header("origin", "http://127.0.0.1:4173")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "authorization")
        .send()
        .await
        .expect("preflight succeeds");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .expect("allow-origin header"),
        "http://127.0.0.1:4173"
    );

    let denied = reqwest::Client::new()
        .request(
            reqwest::Method::OPTIONS,
            format!("http://{address}/v1/status"),
        )
        .header("origin", "https://untrusted.example")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "authorization")
        .send()
        .await
        .expect("denied preflight returns a response");
    assert!(
        denied.headers().get("access-control-allow-origin").is_none(),
        "unconfigured origins must not receive CORS permission"
    );
}

#[tokio::test]
async fn transcribes_a_real_wav_request_through_the_full_http_stack() {
    let address = spawn_server().await;
    let response = reqwest::Client::new()
        .post(format!("http://{address}/v1/transcriptions?language=en"))
        .bearer_auth(TOKEN)
        .header("content-type", "audio/wav")
        .body(wav_fixture())
        .send()
        .await
        .expect("transcription request succeeds");

    assert_eq!(response.status(), StatusCode::OK);
    let transcript: seda_protocol::Transcript =
        response.json().await.expect("transcript is valid JSON");
    assert_eq!(transcript.text, "hello world");
    assert_eq!(transcript.language.as_deref(), Some("en"));
    assert_eq!(transcript.words.len(), 2);
}

#[tokio::test]
async fn rejects_languages_the_active_model_cannot_transcribe() {
    let address = spawn_server().await;
    let response = reqwest::Client::new()
        .post(format!("http://{address}/v1/transcriptions?language=fa"))
        .bearer_auth(TOKEN)
        .header("content-type", "audio/wav")
        .body(wav_fixture())
        .send()
        .await
        .expect("request succeeds");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let error: serde_json::Value = response.json().await.expect("error is valid JSON");
    assert_eq!(error["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn streams_revisions_and_a_final_transcript_over_a_one_time_ticket() {
    let address = spawn_server().await;
    let client = reqwest::Client::new();
    let created: SessionCreated = client
        .post(format!("http://{address}/v1/sessions"))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({
            "language": "en",
            "input": {
                "encoding": "pcm_s16le",
                "sampleRate": 16000,
                "channels": 1
            }
        }))
        .send()
        .await
        .expect("session request succeeds")
        .error_for_status()
        .expect("session is accepted")
        .json()
        .await
        .expect("session response is valid");

    let websocket_url = format!(
        "ws://{address}{}?ticket={}",
        created.websocket_path, created.ticket
    );
    let (mut websocket, _) = tokio_tungstenite::connect_async(websocket_url)
        .await
        .expect("websocket connects");

    let ready = next_event(&mut websocket).await;
    assert!(matches!(ready, ServerEvent::Ready { .. }));

    websocket
        .send(Message::Binary(vec![0_u8; 320].into()))
        .await
        .expect("first audio frame sends");
    websocket
        .send(Message::Binary(vec![0_u8; 320].into()))
        .await
        .expect("second audio frame sends");
    websocket
        .send(Message::Text(r#"{"type":"commit"}"#.into()))
        .await
        .expect("commit sends");

    let mut transcripts = Vec::new();
    let mut completed = None;
    while completed.is_none() {
        match next_event(&mut websocket).await {
            ServerEvent::Transcript {
                text,
                revision,
                final_,
                ..
            } => transcripts.push((text, revision, final_)),
            ServerEvent::Completed { transcript } => completed = Some(transcript),
            _ => {}
        }
    }

    assert_eq!(
        transcripts,
        vec![
            ("hello".to_owned(), 1, false),
            ("hello world".to_owned(), 2, false),
            ("hello world".to_owned(), 3, true),
        ]
    );
    assert_eq!(completed.expect("completion exists").text, "hello world");

    let replay = tokio_tungstenite::connect_async(format!(
        "ws://{address}{}?ticket={}",
        created.websocket_path, created.ticket
    ))
    .await;
    assert!(replay.is_err(), "session tickets are single use");
}

async fn next_event(
    websocket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerEvent {
    loop {
        let message = websocket
            .next()
            .await
            .expect("socket remains open")
            .expect("message is valid");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).expect("event matches protocol");
        }
    }
}

fn wav_fixture() -> Vec<u8> {
    let samples = [0_i16; 800];
    let data_size = u32::try_from(samples.len() * 2).expect("fixture fits");
    let mut bytes = Vec::with_capacity(44 + data_size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&16_000_u32.to_le_bytes());
    bytes.extend_from_slice(&32_000_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

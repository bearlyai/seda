# Architecture

## Boundary

Seda is a speech engine toolkit, not a universal dictation UI.

```text
host app
  ├─ global shortcut and focused-app policy
  ├─ microphone helper or application-owned audio
  ├─ text preview and focused-app insertion
  └─ Seda runtime
       ├─ browser: Worker + cached Moonshine + WebGPU/WASM
       └─ native: verified Parakeet + authenticated loopback protocol
```

Neither runtime grabs a device by itself. The shared microphone helper requests
permission only when the application calls `seda.microphone()` from its own
interaction, then owns capture, resampling, and cleanup. Other hosts can supply
PCM through the lower-level session. Electron, native applets, accessibility
tools, web pages, and headless services still control their own UX and policy.

## Components

- `seda-protocol`: serialization-only public types and protocol version.
- `seda-core`: paths, embedded catalog, installer, and engine/session traits.
- `seda-parakeet`: safe Rust wrapper around parakeet.cpp C ABI v5.
- `seda-cli`: CLI, authenticated Axum service, session registry, actor workers.
- `@bearlyai/seda`: runtime-neutral session types, native HTTP/WebSocket client,
  and browser microphone capture.
- `@bearlyai/seda-browser`: in-process Worker host for Moonshine through
  Transformers.js, WebGPU, and WASM.
- `@bearlyai/seda-node`: sidecar installer and lifecycle manager.
- `sdks/python`, `sdks/go`, and `sdks/swift`: typed protocol clients for hosts
  that manage the native sidecar themselves.

Rust crates are internal implementation units for v0.2 and are not published to
crates.io. The binary and wire protocol are the native compatibility boundary.

## Browser process model

`SedaBrowser.prepare()` creates one module Worker and loads one pinned model. The
Worker owns all Transformers.js and ONNX execution, serializes inference, and
reports download/compile/readiness progress. The page owns only session state,
audio capture, and transcript events.

Moonshine is utterance-based, so a browser session periodically decodes the
current rolling utterance and emits a replacement revision. Commit performs one
final decode. Seda reports this as buffered streaming. The 30-second model limit
also bounds per-session memory.

## Process model

The host selects one exact model ID and variant when it starts Seda. Seda loads
that model once and keeps it resident. Each transcription or live session
chooses its own language. Prompted multilingual models can therefore serve
consecutive languages without a weight reload; fixed and checkpoint models
report that limitation in capabilities.

Each live session creates an engine stream on a blocking actor thread; Tokio
handles only bounded control and event channels. This keeps native inference
out of async reactor threads and makes backpressure explicit.

The current parakeet.cpp adapter serializes access to the model context with a
mutex because the C ABI exposes a shared context. The server limits pending
tickets, WebSocket frame size, audio duration, request body size, and channel
depth.

## Installation

The embedded catalog is the source of truth. An installation:

1. resolves an exact model ID and variant plus OS, architecture, and
   accelerator;
2. downloads to a scoped `.part` file with HTTP range resumption;
3. hashes the complete artifact with SHA-256;
4. rejects mismatches and deletes the bad partial;
5. safely extracts a single-root runtime archive to a temporary directory;
6. atomically renames the verified result into the Seda data directory.

Model weights and native runtimes are never committed to the repository or
GitHub release. `SEDA_HOME` can redirect all managed data for application
packaging, tests, or portable installations.

Profiles are optional aliases resolved before installation. Language is never
an installation key. The prepared cache key is the resolved model ID, revision,
variant, and runtime, so changing a stream language does not duplicate model
files.

The browser host requests the immutable Moonshine model revision recorded in
`packages/browser/src/models.ts`. Transformers.js stores fetched files in the
browser Cache API. Cache eviction can trigger another download; `create()`
is a deprecated alias, while `prepare()` is the single readiness boundary.

## Security model

The default server binds `127.0.0.1:0`, emits a random 256-bit-equivalent token,
and rejects non-loopback listening unless `--allow-network` is explicit.
Control-plane authentication uses constant-time comparison. Live sockets use
short-lived one-time tickets so credentials do not need to become WebSocket
subprotocols or renderer-visible query parameters.

Browser `Origin` is deny-by-default for both HTTP CORS and WebSocket upgrades.
Electron should keep lifecycle control in the main process and expose only
`browserConnection()` through a narrow bridge to a trusted local renderer.

The in-browser runtime has no local server or credential. Its network boundary
is the first model download from the pinned Hugging Face revision. Audio is
passed only between the page and its Worker.

## Adding an engine

Implement `RecognitionEngine` and `RecognitionSession`:

- immutable, honest `EngineMetadata`;
- batch `transcribe`;
- `start_session`;
- incremental `feed`;
- terminal `commit`.

Native adapters emit text deltas, words, EOU, and backchannel events. The server
owns wire revisions, completion, limits, and errors. In-process adapters
implement the exported `TranscriptionSession` contract directly. Capability
negotiation keeps Moonshine, sherpa-onnx, OS-native, remote, or WASM backends
from changing application code or overstating their behavior.

## Deliberate v0.2 constraints

- One resident model per process.
- One language choice per session.
- PCM audio only for live sessions.
- No daemon-owned microphone, global shortcut, or text injection.
- No second-pass refiner until it has measured quality and latency behavior.
- Browser Moonshine Tiny is English-only, buffered, and capped at 30 seconds.
- Native Parakeet remains the true-streaming and multilingual tier.

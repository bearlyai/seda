# Architecture

## Boundary

Seda is a speech engine service, not a universal dictation UI.

```text
host app
  ├─ global shortcut and microphone permissions
  ├─ audio capture/resampling
  ├─ text preview and focused-app insertion
  └─ Seda host
       ├─ model catalog + verified installer
       ├─ native recognition adapter
       └─ authenticated HTTP/WebSocket protocol
```

This division prevents a reusable library from silently requesting invasive OS
permissions. It also lets Electron, native applets, accessibility tools, web
pages, and headless services build the UX appropriate to their platform.

## Components

- `seda-protocol`: serialization-only public types and protocol version.
- `seda-core`: paths, embedded catalog, installer, and engine/session traits.
- `seda-parakeet`: safe Rust wrapper around parakeet.cpp C ABI v5.
- `seda-cli`: CLI, authenticated Axum service, session registry, actor workers.
- `@bearlyai/seda`: universal typed HTTP/WebSocket client.
- `@bearlyai/seda-node`: sidecar installer and lifecycle manager.

Rust crates are internal implementation units for v0.1 and are not published to
crates.io. The binary and wire protocol are the native compatibility boundary.

## Process model

The host selects one profile and language when it starts Seda. Seda loads one
model and keeps it resident. Each live session creates an engine stream on a
blocking actor thread; Tokio handles only bounded control and event channels.
This keeps native inference out of async reactor threads and makes backpressure
explicit.

The current parakeet.cpp adapter serializes access to the model context with a
mutex because the C ABI exposes a shared context. The server limits pending
tickets, WebSocket frame size, audio duration, request body size, and channel
depth.

## Installation

The embedded catalog is the source of truth. An installation:

1. resolves a profile, language, OS, architecture, and accelerator;
2. downloads to a scoped `.part` file with HTTP range resumption;
3. hashes the complete artifact with SHA-256;
4. rejects mismatches and deletes the bad partial;
5. safely extracts a single-root runtime archive to a temporary directory;
6. atomically renames the verified result into the Seda data directory.

Model weights and native runtimes are never committed to the repository or
GitHub release. `SEDA_HOME` can redirect all managed data for application
packaging, tests, or portable installations.

## Security model

The default server binds `127.0.0.1:0`, emits a random 256-bit-equivalent token,
and rejects non-loopback listening unless `--allow-network` is explicit.
Control-plane authentication uses constant-time comparison. Live sockets use
short-lived one-time tickets so credentials do not need to become WebSocket
subprotocols or renderer-visible query parameters.

Browser `Origin` is deny-by-default. Electron should keep credentials in the
main process and expose only a narrow IPC API.

## Adding an engine

Implement `RecognitionEngine` and `RecognitionSession`:

- immutable, honest `EngineMetadata`;
- batch `transcribe`;
- `start_session`;
- incremental `feed`;
- terminal `commit`.

Adapters emit text deltas, words, EOU, and backchannel events. The server owns
wire revisions, completion, limits, and errors. This keeps a Moonshine,
sherpa-onnx, OS-native, remote, or WASM backend from changing application code.

## Deliberate v0.1 constraints

- One resident model per process.
- One language choice per session.
- PCM audio only for live sessions.
- No microphone, VAD abstraction, shortcut, or text injection in core.
- No second-pass refiner until it has measured quality and latency behavior.
- No WASM runtime until model caching, threading, and streaming semantics are
  consistent enough to keep the API honest.

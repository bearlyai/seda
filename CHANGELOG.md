# Changelog

Seda follows semantic versioning. Notable changes are recorded here.

## 0.2.0

- Added `@bearlyai/seda-browser`, a serverless in-browser runtime backed by a
  dedicated Worker, automatic WebGPU/WASM selection, and pinned Moonshine Tiny
  model caching.
- Made `SedaBrowser.prepare({ modelId })` the high-level readiness boundary,
  followed by `microphone()`, live revisions, `stop()`, `cancel()`, and
  `close()`—no port, token, or audio blobs. `create()` remains a deprecated
  compatibility alias.
- Extracted a runtime-neutral `TranscriptionSession` contract so native and
  browser inference share capture and application code.
- Added model download/compile readiness progress, abortable initialization,
  honest buffered-streaming capabilities, and a 30-second utterance bound.
- Added browser integration coverage across Chromium, Firefox, and WebKit,
  Chromium microphone lifecycle coverage, and a real Moonshine WASM acoustic
  test using a checksum-verified speech fixture.
- Reworked all browser documentation around complete microphone and
  Shift-to-talk flows, deployment requirements, model behavior, and error UX.
- Replaced model tiers as the primary interface with exact model ID, immutable
  revision, variant, and runtime identity. Profiles remain convenience aliases.
- Moved language selection from preparation and startup to each transcription
  or live stream, with fixed, prompted, automatic, and checkpoint capability
  semantics.
- Added typed Python, Go, and Swift protocol clients with real Rust-sidecar
  HTTP/WebSocket integration coverage in GitHub Actions.

## 0.1.1

- Added the high-level browser `seda.microphone()` API with permission,
  AudioWorklet capture, downmixing, resampling, cleanup, and live callbacks.
- Added authenticated, exact-origin CORS support to the local service.
- Added `SedaNode.browserConnection()` for explicit trusted-renderer handoff.
- Added a Chromium microphone-to-final-transcript integration test on GitHub.
- Reworked user documentation around complete browser, Electron, CLI, and
  lower-level PCM workflows.
- Added installable JavaScript package tarballs to GitHub releases.

## 0.1.0

- Initial `seda` CLI and authenticated local service.
- Managed Node/Electron host and universal TypeScript client.
- Compact, balanced, and quality model profiles.
- Pinned parakeet.cpp runtime and verified resumable model installation.
- True-streaming WebSocket sessions with partial revisions and final commit.
- macOS arm64, Windows x64, and Linux x64 release and integration matrices.

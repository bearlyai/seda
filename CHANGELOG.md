# Changelog

Seda follows semantic versioning. Notable changes are recorded here.

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

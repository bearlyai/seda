# Platform plan

## v0.1

### macOS Apple Silicon

- Release target: `aarch64-apple-darwin`
- Minimum operating system: macOS 14
- Inference: parakeet.cpp Metal build
- Integration: binary, CLI, Node 22, Electron main
- CI: `macos-14` arm64 for the full build and streaming fixture suite.
  A second `macos-15-intel` lane verifies download, checksum, extraction, and
  discovery of the pinned CPU runtime and model. The exact arm64/Metal
  streaming path is tested on physical Apple Silicon because the upstream
  runtime hangs during inference on GitHub's macOS hosts.

The browser/Electron renderer can use `seda.microphone()` for page-level
capture. The embedding application still owns global shortcut and Accessibility
permissions when it inserts into other applications.

### Windows x64

- Release target: `x86_64-pc-windows-msvc`
- Minimum operating system: Windows 11
- Inference: parakeet.cpp CPU build
- Integration: `.exe`, CLI, Node 22, Electron main
- CI: `windows-2025` x64 GitHub-hosted runner, fixture and real model

Browser/Electron microphone capture is supported. The host owns any global
keyboard hook or UI Automation access.

### Linux x64

- Release target: `x86_64-unknown-linux-gnu`
- Baseline: contemporary glibc distribution
- Inference: parakeet.cpp CPU build
- Integration: binary, CLI, Node 22, Electron main
- CI: `ubuntu-24.04` x64 GitHub-hosted runner, fixture and real model

Desktop key capture and insertion vary across X11, Wayland, portals, and
compositors, which is another reason they remain in the host application.

## Browser

The `@bearlyai/seda` client has a high-level `microphone()` API today. It uses
`getUserMedia` and AudioWorklet, resamples to 16 kHz mono PCM, streams live
revisions, and releases capture on `stop()` or `cancel()`. A Chromium
integration test covers the entire browser-to-daemon flow on every pull
request.

The page must be a secure context, its exact origin must be allowed by the
daemon, and an app launcher must privately hand it the loopback address and
ephemeral token. This does not make an arbitrary public page capable of
silently installing or launching a native daemon.

An in-browser WASM host is planned as a separate adapter. It will use a worker,
browser-native model storage, and the same session semantics.

## Later

- macOS Intel release and CI
- Linux arm64 and Windows arm64
- iOS and Android bindings
- WASM runtime
- optional Moonshine and sherpa-onnx adapters
- measured GPU backends on Windows/Linux

“Supported” means a published binary plus hermetic integration coverage and
model-backed validation, not only that an upstream runtime can theoretically
compile on the target.

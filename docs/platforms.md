# Platform plan

## v0.2

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

`@bearlyai/seda-browser` runs Moonshine Tiny in a dedicated Worker. It prefers
WebGPU and automatically falls back to WASM. The model is downloaded from a
pinned immutable revision and stored in the browser Cache API. No companion,
loopback connection, or token is required.

The high-level `microphone()` API uses `getUserMedia` and AudioWorklet,
resamples to 16 kHz mono PCM, emits buffered live revisions, and releases
capture on `stop()` or `cancel()`.

The session/Worker contract is integration-tested in current Playwright
Chromium, Firefox, and WebKit. The complete fake-device microphone flow and
real Moonshine WASM recognition are tested in Chromium. WebGPU is implemented
as an acceleration tier but is not claimed as CI-validated on hosted GPU
hardware.

The browser tier is English-only and limited to 30-second utterances. Mobile
browsers are not yet a supported launch target because low-memory process
eviction and sustained inference need device testing.

`@bearlyai/seda` remains available for a browser or Electron renderer connected
to a native host. That route provides true-streaming and multilingual Parakeet
profiles but requires an app launcher to hand the trusted page a private
loopback address and token.

## Later

- macOS Intel release and CI
- Linux arm64 and Windows arm64
- iOS and Android bindings
- additional browser language/model tiers
- optional native Moonshine and sherpa-onnx adapters
- measured GPU backends on Windows/Linux

“Supported” means a published binary plus hermetic integration coverage and
model-backed validation, not only that an upstream runtime can theoretically
compile on the target.

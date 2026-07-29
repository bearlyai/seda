# Platform plan

## v0.2

### macOS Apple Silicon

- Release target: `aarch64-apple-darwin`
- Minimum operating system: macOS 14
- Inference: parakeet.cpp Metal build
- Integration: binary, CLI, Node 22, Electron main, Swift protocol client
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
- Integration: `.exe`, CLI, Node 22, Electron main, Python and Go clients
- CI: `windows-2025` x64 GitHub-hosted runner, fixture and real model

Browser/Electron microphone capture is supported. The host owns any global
keyboard hook or UI Automation access.

### Linux x64

- Release target: `x86_64-unknown-linux-gnu`
- Baseline: contemporary glibc distribution
- Inference: parakeet.cpp CPU build
- Integration: binary, CLI, Node 22, Electron main, Python and Go clients
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
models but requires an app launcher to hand the trusted page a private
loopback address and token.

## Native SDKs

The initial Python, Go, and Swift packages are typed clients for Seda protocol
v1. They connect to a sidecar that the application launches or receives from
its installer:

| SDK | Initial target | CI |
| --- | --- | --- |
| Python | Python 3.11+ desktop, automation, and services | Unit + real fixture HTTP/WebSocket on Ubuntu |
| Go | Go 1.23+ desktop tools and services | Unit + real fixture HTTP/WebSocket on Ubuntu |
| Swift | macOS 14+ and iOS 17+ application code | Unit + real fixture HTTP/WebSocket on macOS |

These packages do not yet bundle platform-specific binaries or own microphone
capture. Their intentionally small contract is `connect` → `listen(language:)`
→ `write` → `commit`; the host owns lifecycle, input devices, shortcuts, and
text insertion.

## Later

- macOS Intel release and CI
- Linux arm64 and Windows arm64
- Swift-side package distribution and microphone convenience for iOS
- Android/Kotlin bindings
- additional browser language/model tiers
- optional native Moonshine and sherpa-onnx adapters
- measured GPU backends on Windows/Linux

“Supported” means a published binary plus hermetic integration coverage and
model-backed validation, not only that an upstream runtime can theoretically
compile on the target.

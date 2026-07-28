# Platform plan

## v0.1

### macOS Apple Silicon

- Release target: `aarch64-apple-darwin`
- Minimum operating system: macOS 14
- Inference: parakeet.cpp Metal build
- Integration: binary, CLI, Node 22, Electron main
- CI: `macos-14` arm64 for the full fixture suite and real model. Hosted
  inference forces the CPU backend inside the same Metal-capable library because
  virtualized Metal can hang; the automatic Metal path is tested on physical
  Apple Silicon.

The embedding application owns microphone and Accessibility permissions if it
captures global push-to-talk or inserts into other applications.

### Windows x64

- Release target: `x86_64-pc-windows-msvc`
- Minimum operating system: Windows 11
- Inference: parakeet.cpp CPU build
- Integration: `.exe`, CLI, Node 22, Electron main
- CI: `windows-2025` x64 GitHub-hosted runner, fixture and real model

The host owns microphone consent and any keyboard hook or UI Automation access.

### Linux x64

- Release target: `x86_64-unknown-linux-gnu`
- Baseline: contemporary glibc distribution
- Inference: parakeet.cpp CPU build
- Integration: binary, CLI, Node 22, Electron main
- CI: `ubuntu-24.04` x64 GitHub-hosted runner, fixture and real model

Desktop key capture and insertion vary across X11, Wayland, portals, and
compositors, which is another reason they remain in the host application.

## Browser

The `@bearlyai/seda` client can connect from a permitted browser origin today.
This is useful for a local web UI or an app that has an explicit Seda companion.
It does not make an arbitrary public web page capable of silently launching a
native daemon.

An in-browser WASM host is planned as a separate adapter. It will use a worker,
browser-native model storage, and the same session semantics.

## Later

- macOS Intel release and CI
- Linux arm64 and Windows arm64
- iOS and Android bindings
- WASM runtime
- optional Moonshine and sherpa-onnx adapters
- measured GPU backends on Windows/Linux

“Supported” means a published binary plus hermetic and model-backed CI, not only
that an upstream runtime can theoretically compile on the target.

# Contributing

Issues and focused pull requests are welcome.

## Setup

Install Rust 1.90, Node 22, and pnpm 11.10, then run:

```sh
pnpm install --frozen-lockfile
cargo test --workspace --all-targets --features test-engine
cargo build -p seda-cli --features test-engine
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

Before opening a pull request, also run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

## API changes

Keep host-only choices out of live sessions. New wire fields must have clear
runtime semantics, stable serialization, and integration coverage. Breaking
protocol changes require a new protocol major version.

Model catalog changes must pin an immutable or content-verified artifact,
SHA-256, exact byte size, upstream source, license, languages, and capabilities.
Include a real-model test result for each changed launch target.

Browser changes must keep both supported paths user-level. The in-process lane
must exercise its Worker/session contract in Chromium, Firefox, and WebKit; the
Chromium microphone lane must acquire a media stream, capture and resample
audio, observe a live revision, release tracks, and commit a final transcript.
Model or runtime changes must also pass the opt-in real Moonshine WASM fixture:

```sh
SEDA_REAL_BROWSER_MODEL=1 \
SEDA_REAL_AUDIO=/path/to/speech.wav \
pnpm exec playwright test \
  packages/browser/browser-test/runtime.spec.ts \
  --project chromium \
  --grep "real Moonshine"
```

The native-hosted browser lane must still cover authenticated CORS, WebSocket
audio, a live revision, cleanup, and a final transcript.

By contributing, you agree that your contribution is licensed under Apache-2.0.

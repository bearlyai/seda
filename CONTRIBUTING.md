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
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
(cd sdks/go && go test ./...)
swift test
```

Use the pnpm version pinned in `package.json`. Dependency releases must be at
least seven days old; the workspace rejects younger direct and transitive
versions, including during frozen-lockfile CI installs. Do not add a
`minimumReleaseAgeExclude` entry to make an update pass. Wait for the quarantine
window, or open a narrowly scoped security-policy change for an emergency fix.

Before opening a pull request, also run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

## API changes

Keep host-only choices out of live sessions. New wire fields must have clear
runtime semantics, stable serialization, and integration coverage. Breaking
protocol changes require a new protocol major version.

Model catalog changes must expose an exact upstream ID, immutable revision,
variant, runtime, SHA-256, exact byte size, upstream source, license, language
mode, languages, and capabilities. Profiles are optional aliases. Language
belongs to the transcription or live session and must not become part of model
preparation unless the upstream artifact is genuinely a language-specific
checkpoint. Include a real-model test result for each changed launch target.

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

Python, Go, and Swift changes must pass both unit tests and their env-gated
fixture-sidecar integration test. CI launches the real Rust HTTP/WebSocket
service for those jobs; mocked transport coverage alone is insufficient.

By contributing, you agree that your contribution is licensed under Apache-2.0.

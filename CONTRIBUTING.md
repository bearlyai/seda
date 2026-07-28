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
pnpm exec playwright install chromium
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

Browser changes must keep the microphone integration test user-level: acquire a
media stream, capture and resample audio, pass an authenticated CORS boundary,
stream over WebSocket, observe a live revision, and commit a final transcript.

By contributing, you agree that your contribution is licensed under Apache-2.0.

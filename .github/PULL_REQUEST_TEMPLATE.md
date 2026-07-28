## What changed

## Why this API

## Verification

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- [ ] `cargo test --workspace --all-targets --features test-engine`
- [ ] `pnpm check && pnpm test && pnpm build`
- [ ] Real-model result included when the runtime or catalog changed

## Security and licensing

- [ ] No token, private audio, model weight, or generated runtime is committed
- [ ] New artifacts have exact versions, sizes, SHA-256 values, and licenses

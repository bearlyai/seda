# Seda for Swift

Typed async Swift 6 client for a locally running Seda sidecar on macOS 13+ and
iOS 16+.

## Install

Add the package and link the `Seda` product:

```swift
.package(url: "https://github.com/bearlyai/seda.git", from: "0.2.0")
```

On macOS, prepare and launch the helper by exact model ID:

```sh
seda prepare \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
seda serve \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
```

The application owns the sidecar lifecycle and passes the first JSON stdout
line's `address` and ephemeral `token` into the SDK. An iOS application needs a
separately embedded/native runtime; iOS cannot launch the desktop executable.

## Stream application-owned audio

```swift
let seda = try await Seda.connect(
    baseURL: URL(string: "http://127.0.0.1:7331")!,
    token: token
)

let session = try await seda.listen(language: "de-DE")
try await session.write(pcmS16LE)

let transcript = try await session.commit { update in
    print(update.text)
}
```

`write` accepts raw 16 kHz, mono, signed 16-bit little-endian PCM `Data`.
Transcript callbacks are revisions and should replace the current preview.

## Complete WAV and capabilities

```swift
let transcript = try await seda.transcribe(
    wav: wavData,
    language: "en-US"
)

let capabilities = try await seda.capabilities()
print(
    capabilities.resolvedModel.id,
    capabilities.resolvedModel.revision,
    capabilities.resolvedModel.variant
)
```

The same prepared multilingual model can serve another language by opening a
new session. Language is never required while model weights are prepared.
Catch `SedaError` to inspect its stable `code`, `recoverable`, and `status`
properties.

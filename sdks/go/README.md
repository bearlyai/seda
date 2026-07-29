# Seda for Go

Typed Go 1.23+ client for a locally running Seda sidecar.

## Install

```sh
go get github.com/bearlyai/seda/sdks/go
```

Prepare and launch the helper by exact model ID:

```sh
seda prepare \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
seda serve \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
```

Read the sidecar's first JSON stdout line and hand its `address` and `token` to
your Go process.

## Stream application-owned audio

```go
import "github.com/bearlyai/seda/sdks/go"

client, err := seda.Connect(ctx, seda.Options{
    BaseURL: "http://127.0.0.1:7331",
    Token:   token,
})

session, err := client.Listen(ctx, seda.ListenOptions{
    Language: "de-DE",
})
session.Write(pcmS16LE)

transcript, err := session.Commit(ctx, func(update seda.TranscriptUpdate) {
    fmt.Print("\r", update.Text)
})
```

`Session.Write` accepts raw 16 kHz, mono, signed 16-bit little-endian PCM.
Updates revise the complete preview; do not append them as token deltas.

## Complete WAV and capabilities

```go
transcript, err := client.Transcribe(
    ctx,
    wavBytes,
    seda.TranscribeOptions{Language: "en-US"},
)

capabilities, err := client.Capabilities(ctx)
fmt.Println(
    capabilities.ResolvedModel.ID,
    capabilities.ResolvedModel.Revision,
    capabilities.ResolvedModel.Variant,
)
```

Preparation chooses the concrete model ID and variant. `Listen` chooses a
language for that stream without reloading a prompted multilingual model.
Protocol failures can be inspected with `errors.As(err, *seda.Error)` for a
stable code, recoverability flag, and HTTP status.

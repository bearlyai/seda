# Seda

Local-first speech-to-text with one small, stable API.

Seda—**sedā / صدا**, “sound” or “voice” in Persian—gives web, Electron,
desktop, Node, and applet developers a complete microphone-to-text path.
Browsers run privately in-process with WebGPU or WASM. Native applications can
install Parakeet for true streaming and multilingual models.

**[Try Seda in your browser →](https://bearlyai.github.io/seda/)**

```ts
import { SedaBrowser } from "@bearlyai/seda-browser";

const seda = await SedaBrowser.prepare({
  modelId: "onnx-community/moonshine-tiny-ONNX",
  onProgress: ({ stage, percent }) => {
    showModelInstall(stage, percent);
  },
});
const microphone = await seda.microphone({
  language: "en",
  onTranscript: ({ text }) => {
    preview.textContent = text;
  },
});

// On push-to-talk release:
const final = await microphone.stop();
editor.insertText(final.text);
```

There is no server in that example. `SedaBrowser.prepare()` downloads and caches
the pinned compact model, starts inference in a Worker, prefers WebGPU, falls
back to WASM, and resolves when it is ready. `microphone()` handles permission,
AudioWorklet capture, resampling, live revisions, finalization, and cleanup.

## Start here

### Browser: no companion install

Until npm trusted publishing is configured, install the packages from the
GitHub release:

```sh
pnpm add \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-0.2.0.tgz \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-browser-0.2.0.tgz
```

Initialize the model once during application readiness:

```ts
import { SedaBrowser } from "@bearlyai/seda-browser";

const seda = await SedaBrowser.prepare({
  modelId: "onnx-community/moonshine-tiny-ONNX",
  device: "auto",
  onProgress: updateInstallUI,
});
```

Then connect it directly to the interaction users already understand:

```ts
let microphone;

dictateButton.addEventListener("pointerdown", async () => {
  microphone = seda.microphone({
    language: "en",
    onTranscript: ({ text }) => {
      preview.textContent = text;
    },
  });
});

dictateButton.addEventListener("pointerup", async () => {
  const pending = microphone;
  microphone = undefined;
  if (!pending) return;
  const active = await pending;
  editor.insertText((await active.stop()).text);
});
```

See the complete [browser guide](docs/browser.md) for Shift-to-talk, install
progress, model behavior, error UX, devices, CSP, and teardown.

### Native or Electron: install Parakeet

Download the binary for your OS from the
[latest GitHub release](https://github.com/bearlyai/seda/releases/latest), put
`seda` on `PATH`, and prepare an exact model ID:

```sh
seda prepare \
  --model-id nvidia/parakeet_realtime_eou_120m-v1 \
  --variant q4_k
```

Electron and Node applications should use `SedaNode.prepare()` and
`SedaNode.start()` to own the binary lifecycle. A browser renderer can then use
the same `microphone()` experience through `@bearlyai/seda`. See
[native-hosted browser integration](docs/browser.md#native-hosted-browser-or-electron).

## Launch platforms

| Platform | v0.2 status | Runtime |
| --- | --- | --- |
| Chromium, Firefox, WebKit | Supported in-process | WebGPU or WASM + Moonshine Tiny |
| macOS 14+ on Apple Silicon | Supported and model-tested | Metal |
| Windows 11 x64 | Supported and model-tested | CPU |
| Linux x64, glibc | Supported and model-tested | CPU |
| macOS Intel, Linux/Windows ARM, mobile | Later | Adapter work required |

Every pull request runs the Rust server, TypeScript clients, process lifecycle,
HTTP, CORS, and WebSocket integration suites on all three native launch targets.
Browser sessions run in Chromium, Firefox, and WebKit. Chromium additionally
covers `getUserMedia` → AudioWorklet → in-process Worker → live revisions →
final cleanup. A model lane transcribes a checksum-verified speech fixture
through real Moonshine WASM and real native Parakeet. Exact Metal inference is
tested on physical hardware because the upstream runtime hangs during inference
on GitHub's macOS hosts.

## APIs

Seda has eight intentionally small integration surfaces:

| Surface | Best for | Entry point |
| --- | --- | --- |
| In-browser runtime | Websites and install-free renderers | `SedaBrowser.prepare()`, `seda.microphone()` |
| Managed host | Node and Electron main | `SedaNode.prepare()`, `SedaNode.start()` |
| Native-hosted client | Electron and trusted local pages | `Seda.connect()`, `seda.microphone()` |
| CLI | Shell, installers, diagnostics | `seda prepare|serve|transcribe|doctor|models` |
| Python SDK | Python applications and automation | `Seda.connect()`, `seda.listen()` |
| Go SDK | Go desktop tools and services | `seda.Connect()`, `client.Listen()` |
| Swift SDK | macOS and iOS applications | `Seda.connect()`, `seda.listen()` |
| Wire protocol | Other languages and applets | HTTP + WebSocket protocol v1 |

### In-browser

```ts
import { SedaBrowser } from "@bearlyai/seda-browser";

const seda = await SedaBrowser.prepare({
  modelId: "onnx-community/moonshine-tiny-ONNX",
});
const microphone = await seda.microphone({
  language: "en",
  onTranscript: ({ text }) => renderLiveText(text),
});
const final = await microphone.stop();
```

This mode uses pinned Moonshine Tiny weights, browser cache storage, a dedicated
inference Worker, automatic WebGPU/WASM selection, and honest buffered
revisions. It is English-only and limits one utterance to 30 seconds.

### Node and Electron main

```ts
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
  onProgress: ({ type, completedBytes, totalBytes }) => {
    updateInstaller(type, completedBytes, totalBytes);
  },
});

await using seda = await SedaNode.start({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
  allowedOrigins: ["http://localhost:5173"],
});

const connection = seda.browserConnection();
```

In Electron, run `SedaNode` in the main process and expose
`browserConnection()` only to your trusted, context-isolated renderer through a
narrow preload bridge. Never expose it to remote content.

### Native-hosted browser microphone

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect(await window.seda.connection());
const microphone = await seda.microphone({
  language: "en",
  deviceId: selectedInputId,
  onTranscript: ({ text }) => renderLiveText(text),
});

const transcript = await microphone.stop();
```

`seda.listen()` remains the advanced transport API for hosts that already
produce 16 kHz mono PCM. Normal browser UI should use `seda.microphone()`.
Browser origins must be explicitly allowed when the daemon starts.

### Python, Go, and Swift

All three SDKs connect to the same authenticated local protocol. The model is
already resident; language belongs to the individual stream:

```python
from seda import Seda

seda = Seda.connect("http://127.0.0.1:7331", token)
session = seda.listen(language="de-DE")
session.write(pcm_s16le)
final = session.commit(on_transcript=lambda update: print(update.text))
```

```go
client, _ := seda.Connect(ctx, seda.Options{BaseURL: address, Token: token})
session, _ := client.Listen(ctx, seda.ListenOptions{Language: "de-DE"})
session.Write(pcmS16LE)
final, _ := session.Commit(ctx, func(update seda.TranscriptUpdate) {
    fmt.Print("\r", update.Text)
})
```

```swift
let seda = try await Seda.connect(baseURL: address, token: token)
let session = try await seda.listen(language: "de-DE")
try await session.write(pcmS16LE)
let final = try await session.commit { update in
    print(update.text)
}
```

See [Python](sdks/python/README.md), [Go](sdks/go/README.md), and
[Swift](sdks/swift/README.md) for package-level usage.

### CLI

```text
seda prepare    Download, resume, verify, and install one model ID/variant
seda models     Print the exact embedded model catalog
seda doctor     Report platform and installation readiness as JSON
seda transcribe Transcribe a mono PCM WAV file
seda serve      Start the authenticated HTTP/WebSocket service
```

Concrete model IDs are the reproducible host-level choice. Profiles remain
optional aliases for `compact`, `balanced`, and `quality`. A running process
loads one model once; every session independently supplies a language or
`auto`. Changing languages on a prompted multilingual model does not reload
its weights.

### HTTP and WebSocket

```http
GET  /v1/status
GET  /v1/capabilities
POST /v1/transcriptions?language=en   Content-Type: audio/wav
POST /v1/sessions                     Content-Type: application/json
```

All HTTP control-plane routes require `Authorization: Bearer <token>`. Creating
a session returns a one-use, 60-second WebSocket ticket. The socket accepts
binary 16 kHz mono PCM S16LE frames and two JSON controls:

```json
{"type":"commit"}
{"type":"cancel"}
```

Transcript events carry a stable `segment_id`, monotonic `revision`, full
`text`, stable/unstable partitions, word timestamps when supported, and an
explicit `final` flag. See [the complete API contract](docs/api.md).

## Models

| Model ID | Variant | Download | Languages | Why |
| --- | --- | ---: | --- | --- |
| `onnx-community/moonshine-tiny-ONNX` | `q4` WebGPU / `q8` WASM | ~55 MB | English | Install-free, buffered revisions |
| `nvidia/parakeet_realtime_eou_120m-v1` | `q4_k` | 129 MB | English | Small, true streaming, EOU-aware |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | `q4_k` | 718 MB | 32 ready locales | Multilingual, punctuation, efficient |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | `q8_0` | 984 MB | 32 ready locales | More weight precision |

The native catalog pins runtime version, model URL, byte size, SHA-256, license,
and capabilities. Native downloads resume and are promoted only after
verification. The browser adapter pins an immutable Moonshine revision and
ships its JavaScript/WASM execution runtime in the package; model weights remain
on their upstream host.

See [model selection and alternatives](docs/models.md), including the distinct
browser and native capability tiers.

## Build and test

Requirements for the core: Rust 1.90, Node 22, and pnpm 11.10. SDK
contributors additionally need Python 3.11+, Go 1.23+, and Swift 6.

```sh
pnpm install --frozen-lockfile
cargo test --workspace --all-targets --features test-engine
cargo build -p seda-cli --features test-engine
pnpm check
pnpm test
pnpm build
```

The opt-in real-model test uses the exact same path as CI:

```sh
seda prepare --model-id nvidia/parakeet_realtime_eou_120m-v1 --variant q4_k
SEDA_REAL_MODEL=1 SEDA_REAL_AUDIO=/path/to/speech.wav pnpm test
```

Install the browser engines once and run the complete integration matrix:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

## Design promises

- Local by default: in-browser inference has no server; native hosting uses a
  random loopback port and ephemeral token; neither path has telemetry.
- Honest capability negotiation: clients can inspect model behavior at runtime.
- Exact model identity: capabilities expose model ID, immutable revision,
  quantized variant, runtime, and fixed/prompted/automatic language behavior.
- Stable protocol: runtime and model implementations stay behind protocol v1.
- Usable browser input: permission, capture, downmixing, resampling, cleanup,
  and CORS are part of the supported client path.
- Safe installation: pinned artifacts, streaming hashes, safe archive paths,
  resumable partials, and no shell-spawned child processes.
- Backpressure and limits: bounded actor channels, frame limits, session limits,
  request IDs, and isolated inference workers.
- Model independence: browser Moonshine and native Parakeet implement the same
  runtime-neutral session contract without pretending their streaming behavior
  is identical.

Read [architecture](docs/architecture.md), [platform scope](docs/platforms.md),
[security policy](SECURITY.md), and [contributing](CONTRIBUTING.md).

## License

Seda source code is Apache-2.0. Native runtimes and model weights retain their
own licenses; see [NOTICE](NOTICE) and the embedded
[model catalog](models/catalog.json).

# Seda

Local speech-to-text infrastructure with one small, stable API.

Seda—**sedā / صدا**, “sound” or “voice” in Persian—installs a verified native
runtime and model, runs it as a private local service, and streams transcripts
into desktop, Electron, Node, or browser applications.

```ts
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({ profile: "compact", language: "en" });
await using seda = await SedaNode.start({
  profile: "compact",
  language: "en",
});

const session = await seda.listen({ language: "en" });
session.on("transcript", (update) => editor.preview(update));

pushToTalk.on("audio", (pcm16) => session.write(pcm16));
pushToTalk.on("release", async () => editor.commit(await session.commit()));
```

Seda deliberately does not own the microphone, global shortcut, or focused-app
insertion. The embedding application owns those OS permissions and policies;
Seda owns model installation, inference, streaming revisions, and transport.
That boundary keeps the core portable and auditable.

## Start here

Build the `seda` binary with Rust 1.90 or download it from a GitHub release:

```sh
cargo build --release --locked -p seda-cli
./target/release/seda prepare --profile compact --language en
./target/release/seda transcribe recording.wav --profile compact --language en
```

Start a private local service:

```sh
seda serve --profile compact --language en
```

The first stdout line is machine-readable startup data containing the random
loopback address and ephemeral bearer token. Logs go to stderr. A host process
should read that line and keep the token private.

## Launch platforms

| Platform | v0.1 status | Runtime |
| --- | --- | --- |
| macOS 14+ on Apple Silicon | Supported and model-tested | Metal |
| Windows 11 x64 | Supported and model-tested | CPU |
| Linux x64, glibc | Supported and model-tested | CPU |
| Browser | Client supported; local WASM runtime planned | Connects to Seda service |
| macOS Intel, Linux/Windows ARM, mobile | Later | Adapter work required |

Every pull request runs the Rust server, TypeScript clients, process lifecycle,
HTTP, and WebSocket integration suites on all three launch targets. A second
matrix downloads the pinned compact model and transcribes a checksum-verified
speech fixture through the real native runtime on Linux and Windows. Its macOS
lane downloads, verifies, and diagnoses the pinned native artifacts; Apple
Silicon API and streaming behavior stays in the primary fixture matrix. Exact
Metal inference is tested on physical hardware because the upstream runtime
hangs during inference on GitHub's macOS hosts.

## APIs

Seda has four intentionally small integration surfaces:

| Surface | Best for | Entry point |
| --- | --- | --- |
| Managed host | Node and Electron main | `SedaNode.prepare()`, `SedaNode.start()` |
| Universal client | Browser, renderer-safe proxy, Node | `Seda.connect()` |
| CLI | Shell, installers, diagnostics | `seda prepare|serve|transcribe|doctor|models` |
| Wire protocol | Other languages and applets | HTTP + WebSocket protocol v1 |

### Node and Electron main

```ts
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({
  profile: "balanced",
  language: "de-DE",
  onProgress: ({ type, completedBytes, totalBytes }) => {
    updateInstaller(type, completedBytes, totalBytes);
  },
});

await using seda = await SedaNode.start({
  profile: "balanced",
  language: "de-DE",
});

const session = await seda.listen({ language: "de-DE" });
session.on("transcript", ({ text, stableText, unstableText, final }) => {
  showLiveText({ text, stableText, unstableText, final });
});
session.write(pcm16MonoAt16Khz);
const result = await session.commit();
```

In Electron, run `SedaNode` in the main process. Send only application-specific
transcript events over a narrow IPC bridge; do not expose the service token or
raw Node APIs to a renderer.

### Browser or custom JavaScript host

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect({
  baseUrl: "http://127.0.0.1:43123",
  token,
});

const capabilities = await seda.capabilities();
const transcript = await seda.transcribe(wavBlob, { language: "en" });
```

For live audio, call `seda.listen()`, feed 16 kHz mono `Int16Array` chunks with
`session.write()`, and call `session.commit()` on push-to-talk release. Browser
origins must be explicitly allowed when the daemon starts.

### CLI

```text
seda prepare    Download, resume, verify, and install one profile
seda models     Print the exact embedded model catalog
seda doctor     Report platform and installation readiness as JSON
seda transcribe Transcribe a mono PCM WAV file
seda serve      Start the authenticated HTTP/WebSocket service
```

Profiles are host-level choices. A running process loads one model once;
sessions choose only language and audio format. Seda does not expose switches
that the active runtime cannot honor.

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

| Profile | Model | Download | Languages | Why |
| --- | --- | ---: | --- | --- |
| `compact` | Parakeet Realtime EOU 120M Q4 | 129 MB | English | Small, true streaming, EOU-aware |
| `balanced` | Nemotron 3.5 Streaming 0.6B Q4 | 718 MB | 32 ready locales | Multilingual, punctuation, efficient |
| `quality` | Nemotron 3.5 Streaming 0.6B Q8 | 984 MB | 32 ready locales | More weight precision |

The catalog pins runtime version, model URL, byte size, SHA-256, license, and
capabilities. Downloads resume to a partial file and are promoted only after
verification. Model weights are downloaded from their upstream host and are not
part of Seda’s Apache-2.0 distribution.

See [model selection and alternatives](docs/models.md), including Moonshine,
sherpa-onnx, Whisper, browser/WASM, and why v0.1 begins with parakeet.cpp.

## Build and test

Requirements: Rust 1.90, Node 22, and pnpm 11.10.

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
seda prepare --profile compact --language en
SEDA_REAL_MODEL=1 SEDA_REAL_AUDIO=/path/to/speech.wav pnpm test
```

## Design promises

- Local by default: random loopback port, ephemeral token, no telemetry.
- Honest capability negotiation: clients can inspect model behavior at runtime.
- Stable protocol: runtime and model implementations stay behind protocol v1.
- Safe installation: pinned artifacts, streaming hashes, safe archive paths,
  resumable partials, and no shell-spawned child processes.
- Backpressure and limits: bounded actor channels, frame limits, session limits,
  request IDs, and isolated inference workers.
- Model independence: `RecognitionEngine` is the adapter boundary for adding
  Moonshine, sherpa-onnx, platform-native APIs, or a WASM host later.

Read [architecture](docs/architecture.md), [platform scope](docs/platforms.md),
[security policy](SECURITY.md), and [contributing](CONTRIBUTING.md).

## License

Seda source code is Apache-2.0. Native runtimes and model weights retain their
own licenses; see [NOTICE](NOTICE) and the embedded
[model catalog](models/catalog.json).

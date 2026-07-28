# Seda

Local speech-to-text infrastructure with one small, stable API.

Seda—**sedā / صدا**, “sound” or “voice” in Persian—installs a verified native
runtime and model, runs it as a private local service, and gives desktop,
Electron, Node, and browser applications the same streaming transcript API.

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect(await window.seda.connection());
const microphone = await seda.microphone({
  language: "en",
  onTranscript: ({ text, final }) => {
    transcript.textContent = text;
    transcript.dataset.final = String(final);
  },
});

// On push-to-talk release:
const final = await microphone.stop();
```

`seda.microphone()` requests browser permission, captures the selected input,
downmixes and resamples it to 16 kHz PCM, streams live revisions, and releases
every media track when `stop()` or `cancel()` is called. The native daemon does
not grab devices by itself. Global shortcuts and focused-app insertion remain
explicit responsibilities of the embedding application.

## Start here

### 1. Install the native helper

Download the binary for your OS from the
[latest GitHub release](https://github.com/bearlyai/seda/releases/latest), put
`seda` on `PATH`, then prepare a model:

```sh
seda prepare --profile compact --language en
```

For development, start the private service and allow only your app's exact
browser origin:

```sh
seda serve \
  --profile compact \
  --language en \
  --allow-origin http://localhost:5173
```

The first stdout line is JSON containing the random loopback address and
ephemeral bearer token. Your launcher passes that object to its trusted page;
logs stay on stderr. Production Electron and Node apps should use
`SedaNode.start()` instead of parsing this line themselves.

### 2. Install the JavaScript client

Until npm trusted publishing is configured, install the package tarball from
the latest release:

```sh
pnpm add https://github.com/bearlyai/seda/releases/download/v0.1.1/bearlyai-seda-0.1.1.tgz
```

### 3. Listen to the microphone

Call `microphone()` from a click, key press, or other user gesture:

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect({
  baseUrl: "http://127.0.0.1:43123",
  token: ephemeralTokenFromYourLauncher,
});

let microphone;

dictateButton.addEventListener("pointerdown", () => {
  microphone = seda.microphone({
    language: "en",
    onTranscript: ({ stableText, unstableText }) => {
      stable.textContent = stableText;
      unstable.textContent = unstableText;
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

See the complete [browser microphone guide](docs/browser.md) for connection
handoff, Shift-to-talk, device selection, Electron, permissions, and error UX.

## Launch platforms

| Platform | v0.1 status | Runtime |
| --- | --- | --- |
| macOS 14+ on Apple Silicon | Supported and model-tested | Metal |
| Windows 11 x64 | Supported and model-tested | CPU |
| Linux x64, glibc | Supported and model-tested | CPU |
| Browser | Microphone client supported; local WASM runtime planned | Connects to Seda service |
| macOS Intel, Linux/Windows ARM, mobile | Later | Adapter work required |

Every pull request runs the Rust server, TypeScript clients, process lifecycle,
HTTP, CORS, and WebSocket integration suites on all three launch targets. A
real Chromium test grants a deterministic fake microphone and covers
`getUserMedia` → AudioWorklet → resampling → WebSocket → live revisions → final
transcript. A second matrix downloads the pinned compact model and transcribes
a checksum-verified
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
| Browser client | Web and Electron renderer | `Seda.connect()`, `seda.microphone()` |
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
  allowedOrigins: ["http://localhost:5173"],
});

const connection = seda.browserConnection();
```

In Electron, run `SedaNode` in the main process and expose
`browserConnection()` only to your trusted, context-isolated renderer through a
narrow preload bridge. Never expose it to remote content.

### Browser microphone

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

Install Chromium once and run the full browser microphone integration:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

## Design promises

- Local by default: random loopback port, ephemeral token, no telemetry.
- Honest capability negotiation: clients can inspect model behavior at runtime.
- Stable protocol: runtime and model implementations stay behind protocol v1.
- Usable browser input: permission, capture, downmixing, resampling, cleanup,
  and CORS are part of the supported client path.
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

# Browser guide

Seda has two browser integrations:

| Mode | Package | Inference | Use it when |
| --- | --- | --- | --- |
| In-browser | `@bearlyai/seda-browser` | Worker + WebGPU/WASM | A web page should work without installing a companion |
| Native-hosted | `@bearlyai/seda` | Local Parakeet service | Electron or a launcher wants larger, multilingual, true-streaming models |

Both expose `microphone()`, `listen()`, transcript revisions, `stop()`, and
`cancel()`. Application UI does not handle WAV files or random blobs.

Try the complete microphone path in the
[live Seda browser demo](https://bearlyai.github.io/seda/).

## In-browser: complete push-to-talk

Install:

```sh
pnpm add \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-0.2.0.tgz \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-browser-0.2.0.tgz
```

Initialize once, before the first recording:

```ts
import {
  SedaBrowser,
  type ModelLoadProgress,
} from "@bearlyai/seda-browser";
import type { MicrophoneSession } from "@bearlyai/seda";

const button = document.querySelector<HTMLButtonElement>("#dictate")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
const status = document.querySelector<HTMLElement>("#status")!;

function showInstall(progress: ModelLoadProgress) {
  if (progress.stage === "downloading" && progress.percent !== undefined) {
    status.textContent = `Installing speech model… ${Math.round(progress.percent)}%`;
  } else {
    status.textContent = progress.message ?? progress.stage;
  }
}

const seda = await SedaBrowser.prepare({
  modelId: "onnx-community/moonshine-tiny-ONNX",
  device: "auto",
  onProgress: showInstall,
});

let microphone: Promise<MicrophoneSession> | undefined;

button.addEventListener("pointerdown", (event) => {
  event.currentTarget.setPointerCapture(event.pointerId);
  if (microphone) return;

  const pending = seda.microphone({
    language: "en",
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    onTranscript: ({ stableText, unstableText }) => {
      preview.replaceChildren(
        document.createTextNode(stableText),
        Object.assign(document.createElement("span"), {
          className: "unstable",
          textContent: unstableText,
        }),
      );
    },
  });
  microphone = pending;
  status.textContent = "Requesting microphone…";
  void pending.then(() => {
    if (microphone === pending) status.textContent = "Listening";
  });
});

button.addEventListener("pointerup", async () => {
  const pending = microphone;
  microphone = undefined;
  if (!pending) return;

  status.textContent = "Finishing…";
  const final = await (await pending).stop();
  editor.insertText(final.text);
  status.textContent = "Ready";
});

button.addEventListener("pointercancel", () => {
  const pending = microphone;
  microphone = undefined;
  void pending?.then((active) => active.cancel()).catch(() => undefined);
  status.textContent = "Ready";
});
```

`prepare()` is the installation boundary. It downloads the immutable
`onnx-community/moonshine-tiny-ONNX` revision from Hugging Face on first use,
uses the browser cache on later loads, starts a module Worker, selects WebGPU
when available, falls back to WASM, and warms the model. Its promise resolves
only when the first recording can begin. `seda.model` and
`seda.capabilities().resolvedModel` expose the exact ID, revision, variant, and
runtime that were loaded.

Inference stays in the Worker so it cannot block rendering. Audio stays inside
the page and worker. Seda Browser starts no server, opens no port, creates no
token, and sends no audio to Seda or Bearly.
The package also includes its pinned Transformers.js speech code and ONNX WASM
asset, so it does not download executable runtime code from a CDN.

## Hold Shift to talk

```ts
let microphone: Promise<MicrophoneSession> | undefined;

window.addEventListener("keydown", (event) => {
  if (event.key !== "Shift" || event.repeat || microphone) return;
  microphone = seda.microphone({
    language: "en",
    onTranscript: ({ text }) => {
      preview.textContent = text;
    },
  });
});

window.addEventListener("keyup", async (event) => {
  if (event.key !== "Shift" || !microphone) return;
  const pending = microphone;
  microphone = undefined;
  const final = await (await pending).stop();
  editor.insertText(final.text);
});

window.addEventListener("blur", () => {
  const pending = microphone;
  microphone = undefined;
  void pending?.then((active) => active.cancel()).catch(() => undefined);
});
```

This shortcut works while the page is focused. Browsers deliberately cannot
register a system-wide Shift hook. Electron, a browser extension, or a native
applet must own the global shortcut and forward press/release intent.

## Buffered live text

Moonshine is a fast utterance recognizer, not a cache-aware streaming model.
Seda Browser runs it periodically over the current recording and reports
`streaming: "buffered"`.

```ts
microphone.on("transcript", (update) => {
  // Revisions replace previous text. They are not append-only tokens.
  preview.textContent = update.text;
});
```

Partial updates contain the current text in `unstableText`. The committed
revision has `final: true`, moves the complete text to `stableText`, and is
returned by `stop()`. `partialIntervalMs` defaults to 1,000 ms and can be
configured from 250 to 5,000 ms. Shorter intervals cost more inference time.

One utterance is limited to 30 seconds because that is Moonshine’s supported
buffer. Longer dictation should commit at silence boundaries and start another
session.

## Device selection

Ask for permission before expecting labeled devices:

```ts
const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
permission.getTracks().forEach((track) => track.stop());

const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
  ({ kind }) => kind === "audioinput",
);

const microphone = await seda.microphone({
  deviceId: inputs[0]?.deviceId,
  onTranscript: ({ text }) => {
    preview.textContent = text;
  },
});
```

Omit `deviceId` to follow the current browser default.

## Error UX

```ts
import { SedaError } from "@bearlyai/seda";

try {
  const microphone = await seda.microphone();
} catch (error) {
  if (error instanceof SedaError) {
    if (error.code === "permission_denied") {
      showMicrophonePermissionHelp();
    } else if (error.code === "audio_device_unavailable") {
      showDevicePicker();
    } else {
      showRetry(error.message);
    }
  }
}
```

Use an `AbortSignal` to cancel model installation or a pending microphone
request. Call `cancel()` if a key is released during a startup race. Call
`seda.close()` during application teardown.

## Browser and deployment requirements

- `getUserMedia` requires HTTPS or a loopback development origin.
- AudioWorklet is loaded from a short-lived `blob:` URL, so strict CSP must
  permit the worklet source.
- The bundler must emit the module Worker referenced through
  `new URL("./worker.js", import.meta.url)`.
- Unless assets are mirrored, `connect-src` must permit
  `https://huggingface.co` and `https://cdn-lfs.huggingface.co`.
- WebGPU is an acceleration tier, not a requirement. WASM is the fallback.
- The application build emits roughly 22 MB of ONNX runtime assets. First use
  additionally downloads roughly 55 MB of model files; cache eviction can
  require another model download.
- The current browser model is English-only. Seda rejects unsupported stream
  languages before recording. Use native-hosted Nemotron for multilingual
  recognition today.

The deterministic session API runs in Chromium, Firefox, and WebKit on every
pull request. Chromium additionally runs the complete fake-device microphone
path. A separate GitHub lane downloads the pinned real model and transcribes a
checksum-verified speech fixture through actual browser WASM.

## Native-hosted browser or Electron

Use this mode when the application can install a native helper and wants
Parakeet’s true streaming, multilingual models, or word timestamps.

In Electron main:

```ts
import { ipcMain } from "electron";
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
});
const seda = await SedaNode.start({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
  allowedOrigins: ["http://localhost:5173"],
});

ipcMain.handle("seda:connection", () => seda.browserConnection());
```

In a context-isolated preload:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("seda", {
  connection: () => ipcRenderer.invoke("seda:connection"),
});
```

In the trusted renderer:

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect(await window.seda.connection());
const microphone = await seda.microphone({
  language: "de-DE",
  onTranscript: ({ text }) => {
    preview.textContent = text;
  },
});

const final = await microphone.stop();
```

Do not expose the connection to remote content. A local web launcher can run:

```sh
seda serve \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k \
  --allow-origin http://localhost:5173
```

The page must receive the first stdout object `{ address, token }` through a
private app-specific handoff. Never place the token in source, local storage, a
query string, or analytics.

## Advanced PCM

Hosts that already produce signed 16-bit little-endian mono PCM at 16 kHz can
use the same contract in either mode:

```ts
const session = await seda.listen({ language: "en" });
session.on("transcript", ({ text }) => {
  preview.textContent = text;
});
session.write(pcm16);
const final = await session.commit();
```

Most applications should use `microphone()` instead.

## Model and language lifecycle

The host chooses an exact model once:

```ts
await SedaNode.prepare({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
});

const seda = await SedaNode.start({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
});
```

The renderer chooses a language for each recording:

```ts
const german = await seda.microphone({ language: "de-DE" });
const japanese = await seda.microphone({ language: "ja-JP" });
const detected = await seda.microphone({ language: "auto" });
```

All three sessions reuse the resident Nemotron weights. Check
`capabilities().language` before presenting language choices: fixed checkpoints
cannot change language, while prompted models can change it per session.

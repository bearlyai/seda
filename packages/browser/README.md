# `@bearlyai/seda-browser`

Private speech recognition that runs inside the browser. No daemon, loopback
server, token, account, or uploaded audio.

## Install

Until npm trusted publishing is configured, install both package tarballs from
the GitHub release:

```sh
pnpm add \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-0.2.0.tgz \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-browser-0.2.0.tgz
```

Use a normal browser bundler such as Vite, webpack, Parcel, or esbuild. The
package creates a module Worker with `new URL(..., import.meta.url)`, so the
worker and its WASM assets must be emitted by the bundler.
The pinned Transformers.js speech code and ONNX runtime are bundled; production
pages do not fetch executable runtime code from a third-party CDN.

## Add push-to-talk

```ts
import { SedaBrowser } from "@bearlyai/seda-browser";

const status = document.querySelector("#status")!;
const preview = document.querySelector("#preview")!;

const seda = await SedaBrowser.create({
  onProgress: ({ stage, percent }) => {
    status.textContent =
      stage === "downloading" && percent !== undefined
        ? `Installing speech model… ${Math.round(percent)}%`
        : stage;
  },
});

let microphone;

dictateButton.addEventListener("pointerdown", async () => {
  microphone = await seda.microphone({
    language: "en",
    onTranscript: ({ text }) => {
      preview.textContent = text;
    },
  });
});

dictateButton.addEventListener("pointerup", async () => {
  if (!microphone) return;
  const active = microphone;
  microphone = undefined;
  const final = await active.stop();
  editor.insertText(final.text);
});
```

`SedaBrowser.create()` downloads the pinned Moonshine Tiny model, stores it in
the browser cache, loads it in a Worker, selects WebGPU when it works, falls
back to WASM, and warms inference. It resolves only when speech recognition is
ready. Call it during an install/readiness screen rather than on the first
push-to-talk press.

`microphone()` requests access, creates an AudioWorklet, downmixes and resamples
the selected device to 16 kHz, and starts inference. `stop()` releases every
media track before final inference resolves. `cancel()` releases the same
resources and discards the result.

## API

```ts
const seda = await SedaBrowser.create({
  model: "moonshine-tiny", // default; English, roughly 55 MB of model files
  device: "auto",         // WebGPU, then WASM fallback
  signal,
  onProgress,
});

await seda.status();
await seda.capabilities();

const microphone = await seda.microphone({
  language: "en",
  deviceId,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  partialIntervalMs: 1_000,
  maxAudioSeconds: 30,
  signal,
  onTranscript,
});

microphone.on("transcript", listener);
const final = await microphone.stop();
await microphone.cancel();

await seda.close();
```

Moonshine performs buffered streaming: each partial re-runs recognition over
the current utterance. Treat updates as revisions and replace preview text;
never append them as deltas. Final text has `final: true`, lives in
`stableText`, and is also returned by `stop()`.

## Hold Shift to talk

```ts
let microphone;

window.addEventListener("keydown", (event) => {
  if (event.key !== "Shift" || event.repeat || microphone) return;
  microphone = seda.microphone({
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

A web page receives keys only while focused. A browser extension, Electron
main process, or native app owns system-wide shortcuts.

## Advanced PCM session

Use this only when your app already owns 16 kHz mono signed 16-bit PCM:

```ts
const session = await seda.listen({ language: "en" });
session.on("transcript", ({ text }) => {
  preview.textContent = text;
});

session.write(pcm16);
const final = await session.commit();
```

Normal browser applications should call `microphone()` and never construct
audio blobs or PCM frames.

## Deployment requirements

- Serve the page from HTTPS or a loopback development origin.
- Allow the emitted module Worker in `worker-src`.
- Allow model downloads from `https://huggingface.co` and
  `https://cdn-lfs.huggingface.co` in `connect-src`, unless you mirror the
  pinned assets.
- Budget roughly 55 MB for the compact model, a 22 MB emitted ONNX runtime
  asset, and enough memory for a 30-second utterance.
- Call `close()` when the application is done with speech recognition.

See the repository's
[complete browser guide](https://github.com/bearlyai/seda/blob/main/docs/browser.md)
for error handling, device selection, hosted-native mode, Electron, model
semantics, and test coverage.

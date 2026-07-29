# `@bearlyai/seda-node`

Lifecycle-managed Seda sidecar for Node and Electron main processes.

## Install

Until npm trusted publishing is configured, install both packages attached to
the GitHub release:

```sh
pnpm add \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-0.2.0.tgz \
  https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-node-0.2.0.tgz
```

Install the matching `seda` binary from the same release and put it on `PATH`,
or pass `binaryPath`.

## Prepare and run

```ts
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
  onProgress: updateDownloadUI,
});

await using seda = await SedaNode.start({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
});

const transcript = await seda.transcribe(wavBytes, { language: "de-DE" });
```

The child process is launched without a shell, binds a random loopback port,
uses an ephemeral token, and is stopped by async disposal.
Language is selected on each `transcribe()` or `listen()` call. It is not part
of preparation or startup, so a resident prompted multilingual model can serve
different languages without reloading.

## Connect an Electron renderer microphone

Allow only the renderer's exact origin:

```ts
const seda = await SedaNode.start({
  modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  variant: "q4_k",
  allowedOrigins: ["http://localhost:5173"],
});

ipcMain.handle("seda:connection", () => seda.browserConnection());
```

Expose that one operation through a context-isolated preload. In the renderer,
connect `@bearlyai/seda` and call `seda.microphone()`; the browser client owns
permission, capture, resampling, and cleanup.

`browserConnection()` contains the private service token. Give it only to a
trusted local renderer—never to remote content or a renderer with Node
integration enabled.

## Advanced: stream application-owned PCM

```ts
const session = await seda.listen({ language: "en" });
session.on("transcript", (update) => {
  window.webContents.send("dictation:update", update);
});

session.write(pcm16MonoAt16Khz);
const final = await session.commit();
```

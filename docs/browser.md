# Browser microphone guide

The browser package owns the complete page-level audio path. Application code
does not need to encode WAV files, inspect blobs, choose a browser sample rate,
or push PCM frames.

```text
getUserMedia
  → AudioWorklet capture
  → mono 16 kHz PCM resampling
  → authenticated Seda WebSocket
  → revisable live text
  → final transcript on stop()
```

The native Seda service still performs model installation and inference. A
future WASM host can sit behind the same API, but v0.1.1 browsers connect to a
local companion.

## Complete push-to-talk example

Your app launcher must first provide the page with Seda's private connection
object:

```ts
type SedaConnection = {
  baseUrl: string;
  token: string;
};

declare global {
  interface Window {
    seda: {
      connection(): Promise<SedaConnection>;
    };
  }
}
```

Then the page can implement a complete press-and-hold interaction:

```ts
import {
  Seda,
  SedaError,
  type MicrophoneSession,
} from "@bearlyai/seda";

const button = document.querySelector<HTMLButtonElement>("#dictate")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
const status = document.querySelector<HTMLElement>("#status")!;

const seda = await Seda.connect(await window.seda.connection());
let microphone: Promise<MicrophoneSession> | undefined;

button.addEventListener("pointerdown", (event) => {
  event.currentTarget.setPointerCapture(event.pointerId);
  if (microphone) return;

  status.textContent = "Requesting microphone…";
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
  void pending
    .then(() => {
      if (microphone === pending) status.textContent = "Listening";
    })
    .catch((error: unknown) => {
      if (microphone === pending) microphone = undefined;
      status.textContent =
        error instanceof SedaError ? error.message : "Could not start dictation";
    });
});

button.addEventListener("pointerup", async () => {
  const pending = microphone;
  microphone = undefined;
  if (!pending) return;

  status.textContent = "Finishing…";
  try {
    const active = await pending;
    const final = await active.stop();
    editor.insertText(final.text);
    status.textContent = "Ready";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Dictation failed";
  }
});

button.addEventListener("pointercancel", () => {
  const pending = microphone;
  microphone = undefined;
  void pending
    ?.then((active) => active.cancel())
    .catch(() => undefined);
  status.textContent = "Ready";
});
```

Call `microphone()` from a user gesture. Browsers may reject permission or keep
an `AudioContext` suspended when capture starts from background code.

`stop()` is the important semantic boundary: it stops and releases all browser
media tracks, closes the audio graph, commits the recognizer, and resolves only
after Seda returns the final transcript. `cancel()` performs the same cleanup
but discards the result.

## Hold Shift to talk

This works while your page or desktop renderer has keyboard focus:

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
  const active = await pending;
  const final = await active.stop();
  editor.insertText(final.text);
});

window.addEventListener("blur", () => {
  const pending = microphone;
  microphone = undefined;
  void pending
    ?.then((active) => active.cancel())
    .catch(() => undefined);
});
```

A website cannot register a system-wide Shift shortcut. Electron, a native
applet, or a browser extension must own the global shortcut and forward only
the press/release intent to its trusted page.

## Choose an input device

Ask for permission before expecting labeled device names:

```ts
const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
permission.getTracks().forEach((track) => track.stop());

const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
  (device) => device.kind === "audioinput",
);

const deviceId = inputs[0]?.deviceId;
const microphone = await seda.microphone({
  language: "en",
  ...(deviceId ? { deviceId } : {}),
});
```

Omit `deviceId` to follow the browser's current default input.

## Get connection data into the page

### Electron

Start Seda in the main process and allow the exact renderer origin:

```ts
// main.ts
import { ipcMain } from "electron";
import { SedaNode } from "@bearlyai/seda-node";

await SedaNode.prepare({ profile: "compact", language: "en" });
const seda = await SedaNode.start({
  profile: "compact",
  language: "en",
  allowedOrigins: ["http://localhost:5173"],
});

ipcMain.handle("seda:connection", () => seda.browserConnection());
```

Expose only that operation through a context-isolated preload:

```ts
// preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("seda", {
  connection: () => ipcRenderer.invoke("seda:connection"),
});
```

Use a custom secure application protocol in production and put its exact origin
in `allowedOrigins`. Do not enable Node integration in the renderer, expose the
whole `SedaNode` object, or load remote content into a renderer that receives
the token.

### Local web app

For development:

```sh
seda serve \
  --profile compact \
  --language en \
  --allow-origin http://localhost:5173
```

The first stdout line has this shape:

```json
{"address":"127.0.0.1:43123","token":"ephemeral-64-character-token"}
```

A production web app needs a small native launcher, browser extension native
messaging host, or app-specific deep-link handshake to deliver that object.
The browser sandbox cannot install or silently launch an arbitrary native
binary. Never place a static Seda token in source code, local storage, a query
string, or analytics.

## Origin and page requirements

- The page must be a secure context. HTTPS and loopback development origins
  such as `http://localhost` qualify for microphone access.
- Current Chromium also asks the user for Local Network Access when a public
  HTTPS origin connects to Seda on loopback. The client supplies Chromium's
  `targetAddressSpace: "local"` fetch hint automatically.
- Pass the page's exact origin to `seda serve --allow-origin ...` or
  `SedaNode.start({ allowedOrigins: [...] })`.
- Seda answers authenticated CORS preflights only for configured origins and
  independently validates the WebSocket `Origin`.
- The default AudioWorklet is loaded from a short-lived `blob:` URL. A strict
  Content Security Policy must permit that worklet source.
- Keep the connection token in memory and expose it only to trusted code.

Browser requirements are documented by
[MDN `getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia),
[MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode),
and Chrome's
[Local Network Access guide](https://developer.chrome.com/blog/local-network-access).

## Lower-level audio API

Use this only when another SDK already captures audio:

```ts
const session = await seda.listen({ language: "en" });
session.on("transcript", renderLiveTranscript);

session.write(pcm16MonoAt16Khz);
const final = await session.commit();
```

Live frames are signed 16-bit little-endian PCM, mono, 16 kHz. Partial
transcripts are revisions, not append-only deltas: replace displayed text with
the newest event.

## What GitHub tests

The `Browser microphone` workflow launches Chromium with a deterministic fake
microphone and a real fixture-enabled Seda process. It verifies:

1. authenticated browser CORS negotiation;
2. `Seda.connect()` protocol negotiation;
3. browser microphone permission and `getUserMedia`;
4. AudioWorklet capture and 16 kHz PCM resampling;
5. WebSocket audio streaming and live revisions;
6. `stop()` cleanup and the final transcript.

Real acoustic quality is separately model-tested because a hosted CI runner
does not have a meaningful physical microphone.

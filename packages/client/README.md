# `@bearlyai/seda`

Typed browser client and complete microphone capture path for a local Seda
speech service.

## Install

Until npm trusted publishing is configured, install the package attached to the
GitHub release:

```sh
pnpm add https://github.com/bearlyai/seda/releases/download/v0.2.0/bearlyai-seda-0.2.0.tgz
```

Start the native companion with your exact page origin:

```sh
seda prepare \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
seda serve \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k \
  --allow-origin http://localhost:5173
```

Your launcher should pass the address and ephemeral token from Seda's first
stdout line to the trusted page.

## Record from the browser microphone

```ts
import { Seda } from "@bearlyai/seda";

const seda = await Seda.connect({
  baseUrl: "http://127.0.0.1:43123",
  token: connectionFromYourLauncher.token,
});

const microphone = await seda.microphone({
  language: "de-DE",
  onTranscript: ({ stableText, unstableText }) => {
    stable.textContent = stableText;
    unstable.textContent = unstableText;
  },
});

// Push-to-talk release:
const final = await microphone.stop();
editor.insertText(final.text);
```

`microphone()` requests permission, captures with AudioWorklet, downmixes and
resamples to Seda's 16 kHz wire format, and streams immediately. `stop()` frees
the media tracks and audio graph before resolving with the final transcript.
Use `cancel()` to free everything and discard the result.

Choose a device or browser processing policy when needed:

```ts
const microphone = await seda.microphone({
  language: "de-DE",
  deviceId,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  signal: abortController.signal,
});
```

The page must be a secure context, and `microphone()` should be called from a
user gesture. See the repository's
[browser guide](https://github.com/bearlyai/seda/blob/main/docs/browser.md) for
complete push-to-talk, Shift-key, Electron, and connection-handoff examples.

For a website that must work without a local companion, use
`@bearlyai/seda-browser`. It exposes the same `microphone()` behavior with a
Worker-hosted WebGPU/WASM model and needs no address or token.

The prepared model is process-scoped; `language` is recording-scoped. A
prompted multilingual model can serve `de-DE`, `ja-JP`, and `auto` in
consecutive calls without being prepared again. Inspect
`(await seda.capabilities()).language` before building a language picker.

## Advanced: provide your own PCM

```ts
const session = await seda.listen({ language: "en" });
session.on("transcript", ({ text }) => {
  preview.textContent = text;
});

session.write(pcm16MonoAt16Khz);
const final = await session.commit();
```

The client also works in Node 22+. Node applications can inject a custom
WebSocket implementation with `ConnectOptions.webSocket`.

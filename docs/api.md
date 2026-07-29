# Seda API v1

The public contract has an in-browser runtime, a managed native host, a
universal native-hosted client, and a runtime-neutral session shape. The
surfaces intentionally share the same nouns.

## In-browser runtime

```ts
const seda = await SedaBrowser.create({
  model?: "moonshine-tiny"; // default
  device?: "auto" | "webgpu" | "wasm"; // default: auto
  signal?: AbortSignal;
  onProgress?: (event: ModelLoadProgress) => void;
});

await seda.status(): Promise<Status>;
await seda.capabilities(): Promise<Capabilities>;
await seda.listen(options?: BrowserListenOptions): Promise<BrowserSession>;
await seda.microphone(
  options?: BrowserMicrophoneOptions,
): Promise<MicrophoneSession>;
await seda.close(): Promise<void>;
```

`create()` downloads and caches the pinned model, loads it in a dedicated
module Worker, chooses WebGPU with WASM fallback, warms inference, and resolves
when ready. It starts no server and needs no token.

```ts
interface ModelLoadProgress {
  stage: "loading" | "downloading" | "compiling" | "ready";
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  device?: "webgpu" | "wasm";
  message?: string;
}

interface BrowserMicrophoneOptions extends MicrophoneOptions {
  partialIntervalMs?: number; // 250–5000; default: 1000
  maxAudioSeconds?: number;   // 1–30; default: 30
}
```

Moonshine Tiny is English-only. Its capability reports
`streaming: "buffered"` because every partial is a revisable decode of the
current utterance. It does not claim word timestamps, EOU events, a global
shortcut, or focused-application insertion.

## Managed Node/Electron host

```ts
type Profile = "compact" | "balanced" | "quality";

await SedaNode.prepare({
  binaryPath?: string;
  profile?: Profile;       // default: balanced
  language?: string;       // default: auto
  dataDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (event: PrepareProgress) => void;
}): Promise<void>;

const seda = await SedaNode.start({
  binaryPath?: string;
  profile?: Profile;       // model loaded once at process start
  language?: string;
  dataDirectory?: string;
  allowedOrigins?: string[];
  startupTimeoutMs?: number;
}): Promise<SedaNode>;

await seda.listen({ language?: string }): Promise<Session>;
await seda.transcribe(wav, { language?: string }): Promise<Transcript>;
await seda.capabilities(): Promise<Capabilities>;
seda.browserConnection(): { baseUrl: string; token: string };
await seda.close(): Promise<void>;
```

`SedaNode.start()` spawns the binary directly without a shell, binds only to a
random loopback port, reads one structured readiness line, injects a private
token, and owns child shutdown. It implements `AsyncDisposable`.
`browserConnection()` is an explicit handoff for a trusted browser or Electron
renderer; never give it to remote content.

## Universal JavaScript client

```ts
const seda = await Seda.connect({
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  webSocket?: WebSocketFactory;
});

await seda.status(): Promise<Status>;
await seda.capabilities(): Promise<Capabilities>;
await seda.transcribe(wav, { language?: string }): Promise<Transcript>;
await seda.microphone(options?: MicrophoneOptions): Promise<MicrophoneSession>;
await seda.listen({ language?: string }): Promise<Session>;
```

### Browser microphone

This is the normal browser entry point:

```ts
interface MicrophoneOptions {
  language?: string;
  deviceId?: string;
  echoCancellation?: boolean; // default: true
  noiseSuppression?: boolean; // default: true
  autoGainControl?: boolean;  // default: true
  signal?: AbortSignal;
  onTranscript?: (update: TranscriptUpdate) => void;
}

const microphone = await seda.microphone({ language: "en" });

microphone.on("transcript", listener): () => void;
microphone.on("end-of-utterance", listener): () => void;
microphone.on("backchannel", listener): () => void;
microphone.on("error", listener): () => void;

await microphone.stop(): Promise<Transcript>;
await microphone.cancel(): Promise<void>;
```

`microphone()` calls `getUserMedia`, creates an AudioWorklet, downmixes input,
resamples the browser's hardware rate to 16 kHz, and starts streaming. `stop()`
releases every `MediaStreamTrack`, closes the `AudioContext`, commits the
recognizer, and returns its final result. Call it from a user gesture.

See the [complete browser guide](browser.md) for connection bootstrap and
push-to-talk examples.

### Advanced PCM session

`listen()` is for hosts that already own capture and produce the wire format.
`Session` is both event-driven and async-iterable:

```ts
session.on("transcript", listener): () => void;
session.on("end-of-utterance", listener): () => void;
session.on("backchannel", listener): () => void;
session.on("error", listener): () => void;

session.write(pcm: Int16Array | ArrayBuffer | ArrayBufferView): void;
await session.commit(): Promise<Transcript>;
await session.cancel(): Promise<void>;

for await (const event of session.events) {
  // Consume the raw, typed protocol events.
}
```

`commit()` means “no more audio.” It flushes the active streaming recognizer and
resolves only after the final transcript arrives.

## HTTP

Every control-plane request requires:

```http
Authorization: Bearer <ephemeral token>
```

### `GET /v1/status`

```json
{
  "name": "seda",
  "version": "0.2.0",
  "protocol": 1,
  "ready": true
}
```

### `GET /v1/capabilities`

```json
{
  "runtime": "parakeet.cpp",
  "model": "parakeet-realtime-eou-120m-q4",
  "languages": ["en"],
  "streaming": "true",
  "punctuation": false,
  "wordTimestamps": true,
  "globalPushToTalk": false,
  "focusedAppInsertion": false
}
```

### `POST /v1/transcriptions?language=en`

The request body is a mono PCM WAV file. Seda accepts 16-bit integer or 32-bit
float samples and passes the original sample rate to the engine.

```json
{
  "text": "hello world",
  "words": [
    {"text":"hello","startMs":120,"endMs":440,"confidence":0.98}
  ],
  "language": "en",
  "durationMs": 890
}
```

### `POST /v1/sessions`

```json
{
  "language": "en",
  "input": {
    "encoding": "pcm_s16le",
    "sampleRate": 16000,
    "channels": 1
  }
}
```

Response:

```json
{
  "id": "UUID",
  "websocketPath": "/v1/sessions/UUID/stream",
  "ticket": "one-time-random-ticket"
}
```

The ticket expires after 60 seconds and is removed on its first upgrade attempt.
Browser `Origin` headers are denied unless present in the daemon allowlist.
HTTP requests with an `Origin` receive CORS permission only when the same exact
origin was configured.

## WebSocket

Connect to:

```text
ws://127.0.0.1:<port>/v1/sessions/<id>/stream?ticket=<ticket>
```

Audio frames are raw little-endian signed 16-bit PCM, mono, 16 kHz. Each frame
must be even-length and no larger than 64 KiB.

Client controls:

```json
{"type":"commit"}
{"type":"cancel"}
```

Server events:

```json
{"type":"ready","session_id":"UUID"}

{
  "type":"transcript",
  "segment_id":"segment-1",
  "revision":3,
  "text":"hello wor",
  "stable_text":"hello ",
  "unstable_text":"wor",
  "final":false,
  "words":[]
}

{"type":"end-of-utterance","at_ms":840}
{"type":"backchannel","at_ms":420}
{"type":"completed","transcript":{"text":"hello world","words":[],"durationMs":890}}
{"type":"cancelled"}
{"type":"error","error":{"code":"invalid_audio","message":"...","recoverable":true}}
```

Clients must replace a segment when its `revision` increases; partial text is
not append-only. Protocol v1 currently exposes one segment per push-to-talk
session, but the identifiers make multi-segment sessions forward-compatible.

## Error contract

HTTP errors use:

```json
{
  "error": {
    "code": "model_not_ready",
    "message": "human-readable detail",
    "recoverable": true
  }
}
```

Stable codes include permission, model/download, hardware, audio-device,
invalid-audio, busy, authentication/origin, cancellation, runtime, and internal
failures. JavaScript surfaces them as `SedaError`.

## Shared live-session contract

Native WebSocket sessions and in-browser sessions both implement:

```ts
interface TranscriptionSession {
  readonly id: string;
  readonly events: AsyncIterable<ServerEvent>;
  on(type, listener): () => void;
  write(audio: Int16Array | ArrayBuffer | ArrayBufferView): void;
  commit(): Promise<Transcript>;
  cancel(): Promise<void>;
}
```

That structural contract lets the same `MicrophoneSession` own page capture for
both runtimes. It does not erase capability differences: native Parakeet emits
true streaming, EOU, and word times where supported; browser Moonshine emits
buffered text revisions and final text.

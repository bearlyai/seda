import {
  SedaError,
  type ServerEvent,
  type SessionEventMap,
  type SessionListener,
  type Transcript,
  type TranscriptUpdate,
  type TranscriptionSession,
} from "@bearlyai/seda";
import type { BrowserListenOptions } from "./types.js";
import type { InferenceHost } from "./worker-host.js";

const SAMPLE_RATE = 16_000;
const DEFAULT_PARTIAL_INTERVAL_MS = 1_000;
const MIN_PARTIAL_SAMPLES = SAMPLE_RATE;
const DEFAULT_MAX_AUDIO_SECONDS = 30;

export class BrowserSession implements TranscriptionSession {
  readonly id: string;
  readonly events: AsyncIterable<ServerEvent>;

  readonly #host: InferenceHost;
  readonly #language: string | undefined;
  readonly #partialIntervalMs: number;
  readonly #maxSamples: number;
  readonly #onSettled: () => void;
  readonly #listeners = new Map<
    keyof SessionEventMap,
    Set<SessionListener<never>>
  >();
  readonly #queue: ServerEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<ServerEvent>) => void> = [];
  readonly #chunks: Int16Array[] = [];

  #sampleCount = 0;
  #revision = 0;
  #lastPartialSampleCount = 0;
  #lastPartialAt = 0;
  #partialTimer: ReturnType<typeof setTimeout> | undefined;
  #partialPromise: Promise<void> | undefined;
  #commitPromise: Promise<Transcript> | undefined;
  #terminalError: SedaError | undefined;
  #committed = false;
  #settled = false;

  constructor(
    id: string,
    host: InferenceHost,
    options: BrowserListenOptions,
    onSettled: () => void,
  ) {
    this.id = id;
    this.#host = host;
    this.#language =
      options.language === undefined || options.language === "auto"
        ? undefined
        : options.language;
    this.#partialIntervalMs = boundedInteger(
      options.partialIntervalMs,
      DEFAULT_PARTIAL_INTERVAL_MS,
      250,
      5_000,
      "partialIntervalMs",
    );
    const maxAudioSeconds = boundedInteger(
      options.maxAudioSeconds,
      DEFAULT_MAX_AUDIO_SECONDS,
      1,
      30,
      "maxAudioSeconds",
    );
    this.#maxSamples = maxAudioSeconds * SAMPLE_RATE;
    this.#onSettled = onSettled;
    this.events = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#nextEvent(),
      }),
    };
    this.#pushEvent({ type: "ready", session_id: id });
  }

  on<K extends keyof SessionEventMap>(
    type: K,
    listener: SessionListener<K>,
  ): () => void {
    const listeners =
      this.#listeners.get(type) ?? new Set<SessionListener<never>>();
    listeners.add(listener as SessionListener<never>);
    this.#listeners.set(type, listeners);
    return () => {
      listeners.delete(listener as SessionListener<never>);
    };
  }

  write(audio: Int16Array | ArrayBuffer | ArrayBufferView): void {
    if (this.#settled || this.#committed) {
      throw invalidAudio("cannot write after a session is committed");
    }
    const samples = pcmSamples(audio);
    if (samples.length === 0) {
      return;
    }
    if (this.#sampleCount + samples.length > this.#maxSamples) {
      const error = invalidAudio(
        `audio exceeds this session's ${this.#maxSamples / SAMPLE_RATE}-second limit`,
      );
      this.#fail(error);
      throw error;
    }
    this.#chunks.push(samples);
    this.#sampleCount += samples.length;
    this.#schedulePartial();
  }

  commit(): Promise<Transcript> {
    if (this.#terminalError) {
      return Promise.reject(this.#terminalError);
    }
    this.#committed = true;
    this.#commitPromise ??= this.#finalize();
    return this.#commitPromise;
  }

  async cancel(): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#committed = true;
    this.#clearPartialTimer();
    this.#terminalError = new SedaError({
      code: "cancelled",
      message: "transcription session was cancelled",
      recoverable: true,
    });
    this.#pushEvent({ type: "cancelled" });
    this.#settle();
  }

  async #finalize(): Promise<Transcript> {
    this.#clearPartialTimer();
    try {
      await this.#partialPromise;
      if (this.#terminalError) {
        throw this.#terminalError;
      }
      const text =
        this.#sampleCount === 0
          ? ""
          : await this.#host.transcribe(
              this.#snapshot(),
              this.#language,
            );
      if (this.#terminalError) {
        throw this.#terminalError;
      }
      const normalized = text.trim();
      const update = this.#transcriptUpdate(normalized, true);
      this.#emitTranscript(update);
      const transcript: Transcript = {
        text: normalized,
        words: [],
        ...(this.#language ? { language: this.#language } : {}),
        durationMs: Math.round((this.#sampleCount / SAMPLE_RATE) * 1_000),
      };
      this.#pushEvent({ type: "completed", transcript });
      this.#settle();
      return transcript;
    } catch (cause) {
      if (this.#terminalError) {
        throw this.#terminalError;
      }
      const error = runtimeError(cause);
      this.#fail(error);
      throw error;
    }
  }

  #schedulePartial(): void {
    if (
      this.#sampleCount < MIN_PARTIAL_SAMPLES ||
      this.#sampleCount === this.#lastPartialSampleCount ||
      this.#partialTimer ||
      this.#partialPromise
    ) {
      return;
    }
    const delay = Math.max(
      0,
      this.#partialIntervalMs - (performance.now() - this.#lastPartialAt),
    );
    this.#partialTimer = setTimeout(() => {
      this.#partialTimer = undefined;
      this.#partialPromise = this.#runPartial()
        .catch((cause: unknown) => {
          this.#fail(runtimeError(cause));
        })
        .finally(() => {
          this.#partialPromise = undefined;
          if (!this.#settled && !this.#committed) {
            this.#schedulePartial();
          }
        });
    }, delay);
  }

  async #runPartial(): Promise<void> {
    const sampleCount = this.#sampleCount;
    const text = await this.#host.transcribe(this.#snapshot(), this.#language);
    if (this.#settled || this.#committed) {
      return;
    }
    this.#lastPartialSampleCount = sampleCount;
    this.#lastPartialAt = performance.now();
    this.#emitTranscript(this.#transcriptUpdate(text.trim(), false));
  }

  #transcriptUpdate(text: string, final: boolean): TranscriptUpdate {
    return {
      segmentId: `${this.id}:0`,
      revision: ++this.#revision,
      text,
      stableText: final ? text : "",
      unstableText: final ? "" : text,
      final,
      words: [],
    };
  }

  #emitTranscript(update: TranscriptUpdate): void {
    this.#pushEvent({
      type: "transcript",
      segment_id: update.segmentId,
      revision: update.revision,
      text: update.text,
      stable_text: update.stableText,
      unstable_text: update.unstableText,
      final: update.final,
      words: update.words,
    });
    this.#emit("transcript", update);
  }

  #snapshot(): Float32Array {
    const audio = new Float32Array(this.#sampleCount);
    let offset = 0;
    for (const chunk of this.#chunks) {
      for (let index = 0; index < chunk.length; index += 1) {
        const sample = chunk[index] ?? 0;
        audio[offset + index] = sample / (sample < 0 ? 32_768 : 32_767);
      }
      offset += chunk.length;
    }
    return audio;
  }

  #emit<K extends keyof SessionEventMap>(
    type: K,
    event: SessionEventMap[K],
  ): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      (listener as SessionListener<K>)(event);
    }
  }

  #fail(error: SedaError): void {
    if (this.#settled) {
      return;
    }
    this.#terminalError = error;
    this.#emit("error", error);
    this.#pushEvent({
      type: "error",
      error: {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
      },
    });
    this.#settle();
  }

  #settle(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#clearPartialTimer();
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
    this.#onSettled();
  }

  #pushEvent(event: ServerEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.#queue.push(event);
    }
  }

  #nextEvent(): Promise<IteratorResult<ServerEvent>> {
    const event = this.#queue.shift();
    if (event) {
      return Promise.resolve({ value: event, done: false });
    }
    if (this.#settled) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #clearPartialTimer(): void {
    if (this.#partialTimer) {
      clearTimeout(this.#partialTimer);
      this.#partialTimer = undefined;
    }
  }
}

function pcmSamples(
  audio: Int16Array | ArrayBuffer | ArrayBufferView,
): Int16Array {
  if (audio instanceof Int16Array) {
    return audio.slice();
  }
  const bytes =
    audio instanceof ArrayBuffer
      ? new Uint8Array(audio)
      : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  if (bytes.byteLength % 2 !== 0) {
    throw invalidAudio("16-bit PCM audio must contain an even number of bytes");
  }
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new SedaError({
      code: "invalid_request",
      message: `${name} must be an integer from ${minimum} to ${maximum}`,
      recoverable: true,
    });
  }
  return resolved;
}

function invalidAudio(message: string): SedaError {
  return new SedaError({
    code: "invalid_audio",
    message,
    recoverable: true,
  });
}

function runtimeError(cause: unknown): SedaError {
  if (cause instanceof SedaError) {
    return cause;
  }
  return new SedaError(
    {
      code: "runtime_failed",
      message: cause instanceof Error ? cause.message : "browser inference failed",
      recoverable: true,
    },
    { cause },
  );
}

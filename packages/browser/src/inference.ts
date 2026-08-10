import type { ResolvedBrowserDevice } from "./types.js";

export interface InferenceResult {
  text: string;
}

export interface InferenceBackend {
  transcribe(
    audio: Float32Array,
    language?: string,
  ): Promise<InferenceResult>;
  close(): Promise<void>;
}

type InferenceBackendLoader = (
  device: ResolvedBrowserDevice,
) => Promise<InferenceBackend>;

type InferenceFallbackListener = (
  from: ResolvedBrowserDevice,
  to: ResolvedBrowserDevice,
  cause: unknown,
) => void;

/**
 * Owns one inference backend and advances through the caller's device policy.
 * An automatic WebGPU selection therefore remains recoverable after warmup,
 * including failures that only appear with real audio shapes.
 */
export class InferenceRuntime {
  readonly #candidates: readonly ResolvedBrowserDevice[];
  readonly #load: InferenceBackendLoader;
  readonly #onFallback: InferenceFallbackListener | undefined;

  #candidateIndex = -1;
  #backend: InferenceBackend | undefined;
  #device: ResolvedBrowserDevice | undefined;
  #closed = false;

  constructor(
    candidates: readonly ResolvedBrowserDevice[],
    load: InferenceBackendLoader,
    onFallback?: InferenceFallbackListener,
  ) {
    if (candidates.length === 0) {
      throw new Error("at least one inference device is required");
    }
    this.#candidates = candidates;
    this.#load = load;
    this.#onFallback = onFallback;
  }

  get device(): ResolvedBrowserDevice | undefined {
    return this.#device;
  }

  async prepare(): Promise<ResolvedBrowserDevice> {
    if (this.#closed) {
      throw new Error("inference runtime is closed");
    }
    if (!this.#backend) {
      await this.#loadNext();
    }
    if (!this.#device) {
      throw new Error("no supported inference device is available");
    }
    return this.#device;
  }

  async transcribe(
    audio: Float32Array,
    language?: string,
  ): Promise<InferenceResult> {
    if (this.#closed || !this.#backend) {
      throw new Error("model is not loaded");
    }
    try {
      return await this.#backend.transcribe(audio, language);
    } catch (cause) {
      if (this.#candidateIndex + 1 >= this.#candidates.length) {
        throw cause;
      }
      await this.#backend.close().catch(() => undefined);
      this.#backend = undefined;
      this.#device = undefined;
      const fallback = await this.#loadNext(cause);
      return fallback.transcribe(audio, language);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const backend = this.#backend;
    this.#backend = undefined;
    this.#device = undefined;
    await backend?.close();
  }

  async #loadNext(previousCause?: unknown): Promise<InferenceBackend> {
    let lastCause = previousCause;
    while (this.#candidateIndex + 1 < this.#candidates.length) {
      const previousDevice = this.#candidates[this.#candidateIndex];
      this.#candidateIndex += 1;
      const device = this.#candidates[this.#candidateIndex];
      if (!device) {
        break;
      }
      if (previousDevice) {
        this.#onFallback?.(previousDevice, device, lastCause);
      }
      try {
        const backend = await this.#load(device);
        this.#backend = backend;
        this.#device = device;
        return backend;
      } catch (cause) {
        lastCause = cause;
      }
    }
    throw lastCause ?? new Error("no supported inference device is available");
  }
}

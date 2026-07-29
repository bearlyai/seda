import { SedaError } from "@bearlyai/seda";
import type { BrowserModelSpec } from "./models.js";
import type {
  WorkerRequest,
  WorkerRequestPayload,
  WorkerResponse,
} from "./protocol.js";
import type {
  BrowserDevice,
  ModelLoadProgress,
  ResolvedBrowserDevice,
} from "./types.js";

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

export interface InferenceHost {
  transcribe(audio: Float32Array, language?: string): Promise<string>;
}

export class InferenceWorker implements InferenceHost {
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest<unknown>>();
  #requestId = 0;
  #closed = false;
  #onProgress: ((progress: ModelLoadProgress) => void) | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener("message", this.#handleMessage);
    worker.addEventListener("error", this.#handleError);
    worker.addEventListener("messageerror", this.#handleMessageError);
  }

  static async create(
    model: BrowserModelSpec,
    device: BrowserDevice,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: ModelLoadProgress) => void;
    },
  ): Promise<{ host: InferenceWorker; device: ResolvedBrowserDevice }> {
    if (typeof Worker === "undefined") {
      throw new SedaError({
        code: "unsupported_hardware",
        message: "Seda Browser requires Web Workers",
        recoverable: false,
      });
    }
    if (options.signal?.aborted) {
      throw abortError();
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
        name: "seda-inference",
      });
    } catch (cause) {
      throw new SedaError(
        {
          code: "runtime_failed",
          message:
            "could not start the Seda inference worker; check the page's worker-src policy",
          recoverable: false,
        },
        { cause },
      );
    }

    const host = new InferenceWorker(worker);
    host.#onProgress = options.onProgress;
    options.onProgress?.({
      stage: "loading",
      message: `Loading ${model.name}`,
    });

    const onAbort = () => {
      host.close(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await host.#request<{
        device: ResolvedBrowserDevice;
      }>({
        type: "load",
        modelId: model.id,
        revision: model.revision,
        device,
      });
      return { host, device: result.device };
    } catch (cause) {
      host.close(cause);
      throw normalizeWorkerError(cause);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  transcribe(audio: Float32Array, language?: string): Promise<string> {
    const owned = audio.slice();
    return this.#request<string>(
      language === undefined
        ? { type: "transcribe", audio: owned }
        : { type: "transcribe", audio: owned, language },
      [owned.buffer],
    );
  }

  close(
    reason: unknown = new SedaError({
      code: "cancelled",
      message: "Seda Browser was closed",
      recoverable: true,
    }),
  ): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.removeEventListener("error", this.#handleError);
    this.#worker.removeEventListener(
      "messageerror",
      this.#handleMessageError,
    );
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #request<T>(
    request: WorkerRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new SedaError({
          code: "runtime_failed",
          message: "Seda Browser is closed",
          recoverable: false,
        }),
      );
    }
    const requestId = ++this.#requestId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.#worker.postMessage(
          { ...request, requestId } as WorkerRequest,
          transfer,
        );
      } catch (cause) {
        this.#pending.delete(requestId);
        reject(cause);
      }
    });
  }

  readonly #handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    if (response.type === "progress") {
      this.#onProgress?.(response.progress);
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.type === "error") {
      pending.reject(
        new SedaError({
          code: "runtime_failed",
          message: response.message,
          recoverable: true,
        }),
      );
      return;
    }
    if (response.type === "loaded") {
      pending.resolve({ device: response.device });
      return;
    }
    pending.resolve(response.text);
  };

  readonly #handleError = (event: ErrorEvent): void => {
    this.close(
      new SedaError({
        code: "runtime_failed",
        message: event.message || "Seda inference worker failed",
        recoverable: true,
      }),
    );
  };

  readonly #handleMessageError = (): void => {
    this.close(
      new SedaError({
        code: "runtime_failed",
        message: "Seda inference worker returned an unreadable message",
        recoverable: true,
      }),
    );
  };
}

function abortError(): DOMException {
  return new DOMException("model loading was aborted", "AbortError");
}

function normalizeWorkerError(cause: unknown): unknown {
  if (cause instanceof SedaError || cause instanceof DOMException) {
    return cause;
  }
  return new SedaError(
    {
      code: "runtime_failed",
      message: cause instanceof Error ? cause.message : "model loading failed",
      recoverable: true,
    },
    { cause },
  );
}

import {
  MicrophoneSession,
  SedaError,
  type Capabilities,
  type ModelIdentity,
  type Status,
} from "@bearlyai/seda";
import { BROWSER_MODELS, DEFAULT_MODEL_ID } from "./models.js";
import { BrowserSession } from "./session.js";
import type {
  BrowserListenOptions,
  BrowserMicrophoneOptions,
  ResolvedBrowserDevice,
  SedaBrowserOptions,
} from "./types.js";
import { InferenceWorker } from "./worker-host.js";

const VERSION = "0.2.0";
const PROTOCOL = 1;

export class SedaBrowser {
  readonly #host: InferenceWorker;
  readonly #modelId: keyof typeof BROWSER_MODELS;
  readonly #device: ResolvedBrowserDevice;
  readonly #sessions = new Set<BrowserSession>();
  readonly #microphones = new Set<MicrophoneSession>();
  #closed = false;
  readonly model: ModelIdentity;

  private constructor(
    host: InferenceWorker,
    modelId: keyof typeof BROWSER_MODELS,
    device: ResolvedBrowserDevice,
  ) {
    this.#host = host;
    this.#modelId = modelId;
    this.#device = device;
    const model = BROWSER_MODELS[modelId];
    this.model = {
      id: model.id,
      revision: model.revision,
      variant: model.variants[device],
      runtime: `transformers.js/${device}`,
    };
  }

  /**
   * Downloads, caches, loads, and warms the browser model.
   *
   * The returned runtime is ready for immediate push-to-talk use.
   */
  static async prepare(
    options: SedaBrowserOptions = {},
  ): Promise<SedaBrowser> {
    if (options.modelId && options.model) {
      throw invalidOption("pass modelId, not both modelId and deprecated model");
    }
    if (options.model && options.model !== "moonshine-tiny") {
      throw invalidOption(`unknown browser model alias: ${options.model}`);
    }
    const modelId =
      options.modelId ??
      (options.model === "moonshine-tiny"
        ? "onnx-community/moonshine-tiny-ONNX"
        : DEFAULT_MODEL_ID);
    if (!(modelId in BROWSER_MODELS)) {
      throw invalidOption(`unknown browser model ID: ${modelId}`);
    }
    const requestedDevice = options.device ?? "auto";
    if (!["auto", "webgpu", "wasm"].includes(requestedDevice)) {
      throw invalidOption(`unknown browser device: ${requestedDevice}`);
    }
    const model = BROWSER_MODELS[modelId];
    const loaded = await InferenceWorker.create(
      model,
      requestedDevice,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    return new SedaBrowser(loaded.host, modelId, loaded.device);
  }

  /** @deprecated Use `SedaBrowser.prepare()`. */
  static create(options: SedaBrowserOptions = {}): Promise<SedaBrowser> {
    return SedaBrowser.prepare(options);
  }

  async status(): Promise<Status> {
    return {
      name: "seda-browser",
      version: VERSION,
      protocol: PROTOCOL,
      ready: !this.#closed,
    };
  }

  async capabilities(): Promise<Capabilities> {
    this.#assertOpen();
    const model = BROWSER_MODELS[this.#modelId];
    return {
      runtime: `transformers.js/${this.#device}`,
      model: model.id,
      resolvedModel: this.model,
      language: {
        mode: model.languageMode,
        supported: [...model.languages],
        supportsAuto: model.supportsAuto,
        ...(model.languageMode === "fixed"
          ? { fixed: model.languages[0] }
          : {}),
      },
      languages: [...model.languages],
      streaming: "buffered",
      punctuation: true,
      wordTimestamps: false,
      globalPushToTalk: false,
      focusedAppInsertion: false,
    };
  }

  async listen(
    options: BrowserListenOptions = {},
  ): Promise<BrowserSession> {
    this.#assertOpen();
    validateLanguage(
      options.language,
      BROWSER_MODELS[this.#modelId].languages,
      BROWSER_MODELS[this.#modelId].supportsAuto,
    );
    const id = globalThis.crypto.randomUUID();
    let session: BrowserSession;
    session = new BrowserSession(id, this.#host, options, () => {
      this.#sessions.delete(session);
    });
    this.#sessions.add(session);
    return session;
  }

  /**
   * Opens the microphone and starts local in-browser recognition immediately.
   */
  microphone(
    options: BrowserMicrophoneOptions = {},
  ): Promise<MicrophoneSession> {
    let microphone: MicrophoneSession | undefined;
    return MicrophoneSession.start(
      () =>
        this.listen({
          ...(options.language === undefined
            ? {}
            : { language: options.language }),
          ...(options.partialIntervalMs === undefined
            ? {}
            : { partialIntervalMs: options.partialIntervalMs }),
          ...(options.maxAudioSeconds === undefined
            ? {}
            : { maxAudioSeconds: options.maxAudioSeconds }),
        }),
      options,
      () => {
        if (microphone) {
          this.#microphones.delete(microphone);
        }
      },
    ).then(async (active) => {
      microphone = active;
      if (this.#closed) {
        await active.cancel();
        this.#assertOpen();
      }
      this.#microphones.add(active);
      return active;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(
      [...this.#microphones].map((microphone) =>
        microphone.cancel().catch(() => undefined),
      ),
    );
    this.#microphones.clear();
    await Promise.all(
      [...this.#sessions].map((session) =>
        session.cancel().catch(() => undefined),
      ),
    );
    this.#sessions.clear();
    this.#host.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SedaError({
        code: "runtime_failed",
        message: "Seda Browser is closed",
        recoverable: false,
      });
    }
  }
}

function invalidOption(message: string): SedaError {
  return new SedaError({
    code: "invalid_request",
    message,
    recoverable: true,
  });
}

function validateLanguage(
  language: string | undefined,
  supported: readonly string[],
  supportsAuto: boolean,
): void {
  if (
    language === undefined ||
    (language === "auto" && supportsAuto) ||
    supported.includes(language.toLowerCase().split("-")[0] ?? language)
  ) {
    return;
  }
  throw invalidOption(
    `model supports ${supported.join(", ")}; received ${language}`,
  );
}

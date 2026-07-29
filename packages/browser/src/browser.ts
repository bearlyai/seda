import {
  MicrophoneSession,
  SedaError,
  type Capabilities,
  type Status,
} from "@bearlyai/seda";
import { BROWSER_MODELS, DEFAULT_MODEL } from "./models.js";
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
  readonly #modelName: keyof typeof BROWSER_MODELS;
  readonly #device: ResolvedBrowserDevice;
  readonly #sessions = new Set<BrowserSession>();
  readonly #microphones = new Set<MicrophoneSession>();
  #closed = false;

  private constructor(
    host: InferenceWorker,
    modelName: keyof typeof BROWSER_MODELS,
    device: ResolvedBrowserDevice,
  ) {
    this.#host = host;
    this.#modelName = modelName;
    this.#device = device;
  }

  /**
   * Downloads, caches, loads, and warms the browser model.
   *
   * The returned runtime is ready for immediate push-to-talk use.
   */
  static async create(
    options: SedaBrowserOptions = {},
  ): Promise<SedaBrowser> {
    const modelName = options.model ?? DEFAULT_MODEL;
    if (!(modelName in BROWSER_MODELS)) {
      throw invalidOption(`unknown browser model: ${modelName}`);
    }
    const requestedDevice = options.device ?? "auto";
    if (!["auto", "webgpu", "wasm"].includes(requestedDevice)) {
      throw invalidOption(`unknown browser device: ${requestedDevice}`);
    }
    const model = BROWSER_MODELS[modelName];
    const loaded = await InferenceWorker.create(
      model,
      requestedDevice,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    return new SedaBrowser(loaded.host, modelName, loaded.device);
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
    const model = BROWSER_MODELS[this.#modelName];
    return {
      runtime: `transformers.js/${this.#device}`,
      model: model.name,
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
    validateLanguage(options.language, BROWSER_MODELS[this.#modelName].languages);
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
): void {
  if (
    language === undefined ||
    language === "auto" ||
    supported.includes(language.toLowerCase().split("-")[0] ?? language)
  ) {
    return;
  }
  throw invalidOption(`moonshine-tiny supports English; received ${language}`);
}

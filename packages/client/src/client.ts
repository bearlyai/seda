import { clientError, SedaError } from "./error.js";
import { MicrophoneSession } from "./microphone.js";
import { Session } from "./session.js";
import type {
  Capabilities,
  ErrorBody,
  ListenOptions,
  MicrophoneOptions,
  SessionCreated,
  Status,
  Transcript,
  WebSocketFactory,
  WebSocketLike,
} from "./types.js";

const SUPPORTED_PROTOCOL = 1;

export interface ConnectOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  webSocket?: WebSocketFactory;
}

export class Seda {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocketFactory: WebSocketFactory;

  private constructor(options: ConnectOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocketFactory = options.webSocket ?? defaultWebSocketFactory();
  }

  static async connect(options: ConnectOptions): Promise<Seda> {
    if (!options.token) {
      throw clientError("a bearer token is required");
    }
    const client = new Seda(options);
    const status = await client.status();
    if (status.protocol !== SUPPORTED_PROTOCOL) {
      throw clientError(
        `unsupported Seda protocol ${status.protocol}; this client supports ${SUPPORTED_PROTOCOL}`,
      );
    }
    return client;
  }

  async status(): Promise<Status> {
    return this.#request<Status>("/v1/status");
  }

  async capabilities(): Promise<Capabilities> {
    return this.#request<Capabilities>("/v1/capabilities");
  }

  async transcribe(
    wav: Blob | ArrayBuffer | ArrayBufferView,
    options: { language?: string } = {},
  ): Promise<Transcript> {
    const query = new URLSearchParams(
      options.language === undefined ? {} : { language: options.language },
    );
    const body = wav instanceof Blob ? wav : ownedBytes(wav);
    const path = query.size
      ? `/v1/transcriptions?${query}`
      : "/v1/transcriptions";
    return this.#request<Transcript>(path, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body,
    });
  }

  async listen(options: ListenOptions = {}): Promise<Session> {
    const created = await this.#request<SessionCreated>("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(options.language === undefined
          ? {}
          : { language: options.language }),
        input: {
          encoding: "pcm_s16le",
          sampleRate: 16_000,
          channels: 1,
        },
      }),
    });
    const websocket = new URL(created.websocketPath, this.#baseUrl);
    websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
    websocket.searchParams.set("ticket", created.ticket);
    return Session.connect(
      created.id,
      websocket.toString(),
      this.#webSocketFactory,
    );
  }

  /**
   * Opens the browser microphone, resamples it to Seda's wire format, and
   * starts streaming immediately.
   */
  microphone(options: MicrophoneOptions = {}): Promise<MicrophoneSession> {
    return MicrophoneSession.start(
      () =>
        this.listen(
          options.language === undefined ? {} : { language: options.language },
        ),
      options,
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      const targetAddressSpace = addressSpace(this.#baseUrl);
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        // Chrome uses this hint to request Local Network Access when a public
        // HTTPS app connects to Seda. It distinguishes the loopback and private
        // LAN address spaces; other browsers ignore unknown fetch options.
        ...(targetAddressSpace ? { targetAddressSpace } : {}),
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${this.#token}`,
        },
      } as RequestInit & {
        targetAddressSpace?: "local" | "loopback";
      });
    } catch (cause) {
      throw clientError("could not reach the Seda service", cause);
    }
    if (!response.ok) {
      let body: { error: ErrorBody } | undefined;
      try {
        body = (await response.json()) as { error: ErrorBody };
      } catch {
        // Fall through to the stable generic error below.
      }
      throw new SedaError(
        body?.error ?? {
          code: "runtime_failed",
          message: `Seda request failed with HTTP ${response.status}`,
          recoverable: response.status >= 500,
        },
        { status: response.status },
      );
    }
    return (await response.json()) as T;
  }
}

function addressSpace(url: URL): "local" | "loopback" | undefined {
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  ) {
    return "loopback";
  }
  if (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)
  ) {
    return "local";
  }
  const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match?.[1] && Number(match[1]) >= 16 && Number(match[1]) <= 31) {
    return "local";
  }
  if (
    host.startsWith("[fc") ||
    host.startsWith("[fd") ||
    host.startsWith("[fe8") ||
    host.startsWith("[fe9") ||
    host.startsWith("[fea") ||
    host.startsWith("[feb")
  ) {
    return "local";
  }
  return undefined;
}

function ownedBytes(
  value: ArrayBuffer | ArrayBufferView,
): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return bytes;
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw clientError("baseUrl must use http or https");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function defaultWebSocketFactory(): WebSocketFactory {
  const WebSocketConstructor = globalThis.WebSocket as
    | (new (url: string) => WebSocketLike)
    | undefined;
  if (!WebSocketConstructor) {
    throw clientError(
      "this runtime has no WebSocket implementation; pass ConnectOptions.webSocket",
    );
  }
  return (url) => new WebSocketConstructor(url);
}

import { clientError, SedaError } from "./error.js";
import type {
  ErrorBody,
  ServerEvent,
  Transcript,
  TranscriptUpdate,
  WebSocketFactory,
  WebSocketLike,
} from "./types.js";

type SessionEventMap = {
  transcript: TranscriptUpdate;
  "end-of-utterance": { atMs: number };
  backchannel: { atMs: number };
  error: SedaError;
};

type Listener<K extends keyof SessionEventMap> = (
  event: SessionEventMap[K],
) => void;

export class Session {
  readonly id: string;
  readonly events: AsyncIterable<ServerEvent>;

  readonly #socket: WebSocketLike;
  readonly #listeners = new Map<keyof SessionEventMap, Set<Listener<never>>>();
  readonly #queue: ServerEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<ServerEvent>) => void> = [];
  readonly #completed: Promise<Transcript>;

  #resolveCompleted!: (transcript: Transcript) => void;
  #rejectCompleted!: (error: unknown) => void;
  #committed = false;
  #settled = false;

  private constructor(id: string, socket: WebSocketLike) {
    this.id = id;
    this.#socket = socket;
    this.#completed = new Promise<Transcript>((resolve, reject) => {
      this.#resolveCompleted = resolve;
      this.#rejectCompleted = reject;
    });
    this.events = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#nextEvent(),
      }),
    };
    socket.addEventListener("message", (event) => {
      void this.#handleMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (!this.#settled) {
        this.#fail(
          clientError(
            `transcription session closed before completion (${event.code}: ${event.reason})`,
          ),
        );
      }
    });
    socket.addEventListener("error", (cause) => {
      if (!this.#settled) {
        this.#fail(clientError("transcription WebSocket failed", cause));
      }
    });
  }

  static async connect(
    id: string,
    url: string,
    webSocketFactory: WebSocketFactory,
  ): Promise<Session> {
    const socket = webSocketFactory(url);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        (cause) =>
          reject(clientError("could not open transcription session", cause)),
        { once: true },
      );
    });
    return new Session(id, socket);
  }

  on<K extends keyof SessionEventMap>(
    type: K,
    listener: Listener<K>,
  ): () => void {
    const listeners =
      this.#listeners.get(type) ?? new Set<Listener<never>>();
    listeners.add(listener as Listener<never>);
    this.#listeners.set(type, listeners);
    return () => {
      listeners.delete(listener as Listener<never>);
    };
  }

  write(audio: Int16Array | ArrayBuffer | ArrayBufferView): void {
    if (this.#settled || this.#committed) {
      throw clientError("cannot write after a session is committed");
    }
    if (audio instanceof Int16Array) {
      const bytes = new Uint8Array(audio.byteLength);
      bytes.set(
        new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
      );
      this.#socket.send(bytes);
      return;
    }
    this.#socket.send(audio);
  }

  async commit(): Promise<Transcript> {
    if (!this.#settled && !this.#committed) {
      this.#committed = true;
      this.#socket.send(JSON.stringify({ type: "commit" }));
    }
    return this.#completed;
  }

  async cancel(): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#socket.send(JSON.stringify({ type: "cancel" }));
    try {
      await this.#completed;
    } catch (error) {
      if (!(error instanceof SedaError) || error.code !== "cancelled") {
        throw error;
      }
    }
  }

  async #handleMessage(raw: unknown): Promise<void> {
    const text = await messageText(raw);
    let event: ServerEvent;
    try {
      event = JSON.parse(text) as ServerEvent;
    } catch (cause) {
      this.#fail(clientError("server sent invalid JSON", cause));
      return;
    }

    this.#pushEvent(event);
    switch (event.type) {
      case "transcript": {
        const update: TranscriptUpdate = {
          segmentId: event.segment_id,
          revision: event.revision,
          text: event.text,
          stableText: event.stable_text,
          unstableText: event.unstable_text,
          final: event.final,
          words: event.words,
        };
        this.#emit("transcript", update);
        break;
      }
      case "end-of-utterance":
        this.#emit("end-of-utterance", { atMs: event.at_ms });
        break;
      case "backchannel":
        this.#emit("backchannel", { atMs: event.at_ms });
        break;
      case "completed":
        this.#settled = true;
        this.#resolveCompleted(event.transcript);
        break;
      case "cancelled":
        this.#fail({
          code: "cancelled",
          message: "transcription session was cancelled",
          recoverable: true,
        });
        break;
      case "error":
        this.#fail(event.error);
        break;
      case "ready":
        break;
    }
  }

  #emit<K extends keyof SessionEventMap>(
    type: K,
    event: SessionEventMap[K],
  ): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      (listener as Listener<K>)(event);
    }
  }

  #fail(error: ErrorBody | SedaError): void {
    const typed = error instanceof SedaError ? error : new SedaError(error);
    this.#emit("error", typed);
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectCompleted(typed);
    }
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
}

async function messageText(raw: unknown): Promise<string> {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Blob) {
    return raw.text();
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw);
  }
  throw clientError("server sent an unsupported WebSocket message");
}

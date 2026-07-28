export type Profile = "compact" | "balanced" | "quality";
export type StreamingKind = "true" | "buffered" | "none";

export interface Status {
  name: string;
  version: string;
  protocol: number;
  ready: boolean;
}

export interface Capabilities {
  runtime: string;
  model: string;
  languages: string[];
  streaming: StreamingKind;
  punctuation: boolean;
  wordTimestamps: boolean;
  globalPushToTalk: boolean;
  focusedAppInsertion: boolean;
}

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface Transcript {
  text: string;
  words: Word[];
  language?: string;
  durationMs: number;
}

export interface TranscriptUpdate {
  segmentId: string;
  revision: number;
  text: string;
  stableText: string;
  unstableText: string;
  final: boolean;
  words: Word[];
}

export interface ListenOptions {
  language?: string;
}

export interface MicrophoneOptions extends ListenOptions {
  deviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  signal?: AbortSignal;
  onTranscript?: (update: TranscriptUpdate) => void;
}

export interface SessionEventMap {
  transcript: TranscriptUpdate;
  "end-of-utterance": { atMs: number };
  backchannel: { atMs: number };
  error: import("./error.js").SedaError;
}

export interface SessionCreated {
  id: string;
  websocketPath: string;
  ticket: string;
}

export type ErrorCode =
  | "permission_denied"
  | "model_not_ready"
  | "download_required"
  | "download_failed"
  | "unsupported_hardware"
  | "invalid_audio"
  | "audio_device_unavailable"
  | "audio_device_lost"
  | "session_busy"
  | "invalid_request"
  | "unauthorized"
  | "origin_denied"
  | "cancelled"
  | "runtime_failed"
  | "internal";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

export type ServerEvent =
  | { type: "ready"; session_id: string }
  | ({
      type: "transcript";
      segment_id: string;
      stable_text: string;
      unstable_text: string;
    } & Omit<TranscriptUpdate, "segmentId" | "stableText" | "unstableText">)
  | { type: "end-of-utterance"; at_ms: number }
  | { type: "backchannel"; at_ms: number }
  | { type: "completed"; transcript: Transcript }
  | { type: "cancelled" }
  | { type: "error"; error: ErrorBody };

export interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: WebSocketMessageEvent) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: WebSocketCloseEvent) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

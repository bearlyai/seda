import type {
  BrowserDevice,
  ModelLoadProgress,
  ResolvedBrowserDevice,
} from "./types.js";

export type WorkerRequest =
  | {
      type: "load";
      requestId: number;
      modelId: string;
      revision: string;
      device: BrowserDevice;
    }
  | {
      type: "transcribe";
      requestId: number;
      audio: Float32Array;
      language?: string;
    };

export type WorkerRequestPayload = WorkerRequest extends infer Request
  ? Request extends WorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export type WorkerResponse =
  | { type: "progress"; progress: ModelLoadProgress }
  | {
      type: "loaded";
      requestId: number;
      device: ResolvedBrowserDevice;
    }
  | { type: "result"; requestId: number; text: string }
  | { type: "error"; requestId: number; message: string };

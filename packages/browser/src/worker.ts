/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type {
  BrowserDevice,
  ModelLoadProgress,
  ResolvedBrowserDevice,
} from "./types.js";

const worker = self as DedicatedWorkerGlobalScope;
const SAMPLE_RATE = 16_000;

interface TranscriptionResult {
  text: string;
}

type Transcriber = (
  audio: Float32Array,
  options?: { language?: string },
) => Promise<TranscriptionResult>;

let transcriber: Transcriber | undefined;
let inferenceChain: Promise<void> = Promise.resolve();

env.allowLocalModels = false;
env.useBrowserCache = true;
const wasmBackend = env.backends.onnx.wasm;
if (!wasmBackend) {
  throw new Error("Transformers.js did not initialize its WASM backend");
}
wasmBackend.wasmPaths = {
  mjs: new URL(
    "./ort-wasm-simd-threaded.jsep.mjs",
    import.meta.url,
  ),
  wasm: new URL(
    "./ort-wasm-simd-threaded.jsep.wasm",
    import.meta.url,
  ),
};

worker.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  // DedicatedWorker messages normally have an empty origin because the port
  // is private to its creator. If a browser supplies one, accept only the
  // worker's own origin.
  if (event.origin !== "" && event.origin !== worker.location.origin) {
    return;
  }
  const request = event.data;
  inferenceChain = inferenceChain.then(
    () => handleRequest(request),
    () => handleRequest(request),
  );
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === "load") {
      const device = await loadModel(request);
      post({ type: "loaded", requestId: request.requestId, device });
      return;
    }
    if (!transcriber) {
      throw new Error("model is not loaded");
    }
    const result = await transcriber(
      request.audio,
      request.language === undefined ? {} : { language: request.language },
    );
    post({
      type: "result",
      requestId: request.requestId,
      text: result.text,
    });
  } catch (cause) {
    post({
      type: "error",
      requestId: request.requestId,
      message: errorMessage(cause),
    });
  }
}

async function loadModel(
  request: Extract<WorkerRequest, { type: "load" }>,
): Promise<ResolvedBrowserDevice> {
  const candidates = await devicesFor(request.device);
  let lastError: unknown;
  for (const device of candidates) {
    try {
      const loaded = (await pipeline(
        "automatic-speech-recognition",
        request.modelId,
        {
          revision: request.revision,
          device,
          dtype:
            device === "webgpu"
              ? {
                  encoder_model: "fp32",
                  decoder_model_merged: "q4",
                }
              : {
                  encoder_model: "fp32",
                  decoder_model_merged: "q8",
                },
          progress_callback: (value: unknown) => {
            const progress = modelProgress(value, device);
            if (progress) {
              post({ type: "progress", progress });
            }
          },
        },
      )) as unknown as Transcriber;

      post({
        type: "progress",
        progress: {
          stage: "compiling",
          device,
          message: `Warming ${device} inference`,
        },
      });
      await loaded(new Float32Array(SAMPLE_RATE));
      transcriber = loaded;
      post({
        type: "progress",
        progress: {
          stage: "ready",
          device,
          message: `Ready on ${device}`,
        },
      });
      return device;
    } catch (cause) {
      lastError = cause;
      if (request.device !== "auto" || device === "wasm") {
        throw cause;
      }
      post({
        type: "progress",
        progress: {
          stage: "loading",
          device: "wasm",
          message: "WebGPU was unavailable; falling back to WASM",
        },
      });
    }
  }
  throw lastError ?? new Error("no supported inference device is available");
}

async function devicesFor(
  requested: BrowserDevice,
): Promise<ResolvedBrowserDevice[]> {
  if (requested !== "auto") {
    return [requested];
  }
  if (await supportsWebGpu()) {
    return ["webgpu", "wasm"];
  }
  return ["wasm"];
}

async function supportsWebGpu(): Promise<boolean> {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function modelProgress(
  value: unknown,
  device: ResolvedBrowserDevice,
): ModelLoadProgress | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const status = typeof raw["status"] === "string" ? raw["status"] : "";
  const file = typeof raw["file"] === "string" ? raw["file"] : undefined;
  const loaded =
    typeof raw["loaded"] === "number" ? raw["loaded"] : undefined;
  const total = typeof raw["total"] === "number" ? raw["total"] : undefined;
  const percent =
    typeof raw["progress"] === "number"
      ? raw["progress"]
      : loaded !== undefined && total
        ? (loaded / total) * 100
        : undefined;
  const stage =
    status === "progress" || status === "download"
      ? "downloading"
      : "loading";
  return {
    stage,
    ...(file ? { file } : {}),
    ...(loaded === undefined ? {} : { loadedBytes: loaded }),
    ...(total === undefined ? {} : { totalBytes: total }),
    ...(percent === undefined ? {} : { percent }),
    device,
  };
}

function post(message: WorkerResponse): void {
  worker.postMessage(message);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : "browser inference failed";
}

import type { MicrophoneOptions } from "@bearlyai/seda";

export type BrowserModelId = "onnx-community/moonshine-tiny-ONNX";
/** @deprecated Use `BrowserModelId`. */
export type BrowserModel = "moonshine-tiny";
export type BrowserDevice = "auto" | "webgpu" | "wasm";
export type ResolvedBrowserDevice = Exclude<BrowserDevice, "auto">;

export type ModelLoadStage =
  | "loading"
  | "downloading"
  | "compiling"
  | "ready";

export interface ModelLoadProgress {
  stage: ModelLoadStage;
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  device?: ResolvedBrowserDevice;
  message?: string;
}

export interface SedaBrowserOptions {
  /**
   * Exact model ID. Defaults to `onnx-community/moonshine-tiny-ONNX`.
   */
  modelId?: BrowserModelId;
  /** @deprecated Use `modelId`. */
  model?: BrowserModel;
  /**
   * `auto` prefers WebGPU and falls back to WASM. Defaults to `auto`.
   */
  device?: BrowserDevice;
  signal?: AbortSignal;
  onProgress?: (progress: ModelLoadProgress) => void;
}

export interface BrowserListenOptions {
  /**
   * Stream-scoped BCP-47 language or `auto`. Preparing a prompted
   * multilingual model never needs to be repeated between languages.
   */
  language?: string;
  /**
   * Minimum time between revisable transcript updates. Defaults to 1000 ms.
   */
  partialIntervalMs?: number;
  /**
   * Hard model and memory bound for one session. Defaults to 30 seconds.
   */
  maxAudioSeconds?: number;
}

export interface BrowserMicrophoneOptions
  extends MicrophoneOptions,
    Omit<BrowserListenOptions, "language"> {}

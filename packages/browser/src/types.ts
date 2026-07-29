import type { MicrophoneOptions } from "@bearlyai/seda";

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
   * Curated browser model. Defaults to `moonshine-tiny`.
   */
  model?: BrowserModel;
  /**
   * `auto` prefers WebGPU and falls back to WASM. Defaults to `auto`.
   */
  device?: BrowserDevice;
  signal?: AbortSignal;
  onProgress?: (progress: ModelLoadProgress) => void;
}

export interface BrowserListenOptions {
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

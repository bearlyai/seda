import type { LanguageMode } from "@bearlyai/seda";
import type {
  BrowserModelId,
  ResolvedBrowserDevice,
} from "./types.js";

export interface BrowserModelSpec {
  readonly id: string;
  readonly revision: string;
  readonly variants: Readonly<Record<ResolvedBrowserDevice, string>>;
  readonly displayName: string;
  readonly languages: readonly string[];
  readonly languageMode: LanguageMode;
  readonly supportsAuto: boolean;
}

export const DEFAULT_MODEL_ID: BrowserModelId =
  "onnx-community/moonshine-tiny-ONNX";

export const BROWSER_MODELS: Readonly<
  Record<BrowserModelId, BrowserModelSpec>
> = {
  "onnx-community/moonshine-tiny-ONNX": {
    id: "onnx-community/moonshine-tiny-ONNX",
    revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
    variants: {
      webgpu: "q4",
      wasm: "q8",
    },
    displayName: "Moonshine Tiny ONNX",
    languages: ["en"],
    languageMode: "fixed",
    supportsAuto: false,
  },
};

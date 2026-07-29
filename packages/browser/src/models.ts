import type { BrowserModel } from "./types.js";

export interface BrowserModelSpec {
  readonly name: BrowserModel;
  readonly id: string;
  readonly revision: string;
  readonly languages: readonly string[];
}

export const DEFAULT_MODEL: BrowserModel = "moonshine-tiny";

export const BROWSER_MODELS: Readonly<Record<BrowserModel, BrowserModelSpec>> = {
  "moonshine-tiny": {
    name: "moonshine-tiny",
    id: "onnx-community/moonshine-tiny-ONNX",
    revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
    languages: ["en"],
  },
};


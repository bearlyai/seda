import { copyFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const onnxRuntimeDist = dirname(
  fileURLToPath(import.meta.resolve("onnxruntime-web")),
);
const runtimeAssets = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
];
const retiredRuntimeAssets = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

await build({
  entryPoints: [resolve(packageRoot, "src/worker.ts")],
  outfile: resolve(packageRoot, "dist/worker.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  conditions: ["onnxruntime-web-use-extern-wasm"],
  minify: true,
  sourcemap: true,
});

await Promise.all(
  runtimeAssets.map((asset) =>
    copyFile(
      resolve(onnxRuntimeDist, asset),
      resolve(packageRoot, "dist", asset),
    ),
  ),
);

await Promise.all(
  retiredRuntimeAssets.map((asset) =>
    rm(resolve(packageRoot, "dist", asset), { force: true }),
  ),
);

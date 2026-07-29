import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformersDist = dirname(
  fileURLToPath(import.meta.resolve("@huggingface/transformers")),
);
const runtimeAssets = [
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
  minify: true,
  sourcemap: true,
});

await Promise.all(
  runtimeAssets.map((asset) =>
    copyFile(
      resolve(transformersDist, asset),
      resolve(packageRoot, "dist", asset),
    ),
  ),
);

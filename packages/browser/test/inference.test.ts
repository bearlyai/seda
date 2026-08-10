import { describe, expect, it } from "vitest";
import {
  InferenceRuntime,
  type InferenceBackend,
} from "../src/inference.js";

const audio = new Float32Array(16_000);

describe("InferenceRuntime", () => {
  it("retries an auto-selected WebGPU inference on WASM", async () => {
    const loaded: string[] = [];
    const closed: string[] = [];
    const fallbacks: string[] = [];
    const runtime = new InferenceRuntime(
      ["webgpu", "wasm"],
      async (device): Promise<InferenceBackend> => {
        loaded.push(device);
        return {
          transcribe: async () => {
            if (device === "webgpu") {
              throw new Error("Failed to run JSEP kernel");
            }
            return { text: "recovered transcript" };
          },
          close: async () => {
            closed.push(device);
          },
        };
      },
      (from, to) => {
        fallbacks.push(`${from}->${to}`);
      },
    );

    await runtime.prepare();
    expect(runtime.device).toBe("webgpu");

    await expect(runtime.transcribe(audio)).resolves.toEqual({
      text: "recovered transcript",
    });
    expect(runtime.device).toBe("wasm");
    expect(loaded).toEqual(["webgpu", "wasm"]);
    expect(closed).toEqual(["webgpu"]);
    expect(fallbacks).toEqual(["webgpu->wasm"]);
  });

  it("does not hide an explicit WebGPU inference failure", async () => {
    const runtime = new InferenceRuntime(["webgpu"], async () => ({
      transcribe: async () => {
        throw new Error("Failed to run JSEP kernel");
      },
      close: async () => undefined,
    }));

    await runtime.prepare();

    await expect(runtime.transcribe(audio)).rejects.toThrow(
      "Failed to run JSEP kernel",
    );
    expect(runtime.device).toBe("webgpu");
  });
});

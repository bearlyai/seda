import { describe, expect, it } from "vitest";
import { PcmResampler } from "../src/microphone.js";

describe("browser microphone resampling", () => {
  it("resamples browser-rate floats into bounded 16 kHz PCM frames", () => {
    const output: Int16Array[] = [];
    const resampler = new PcmResampler(48_000, 16_000, (frame) => {
      output.push(frame);
    });
    const input = new Float32Array(960);
    input.fill(0.5);

    resampler.push(input.subarray(0, 128));
    resampler.push(input.subarray(128, 640));
    resampler.push(input.subarray(640));
    resampler.flush();

    expect(output).toHaveLength(1);
    expect(output[0]).toHaveLength(320);
    expect(output[0]?.every((sample) => sample === 16_384)).toBe(true);
  });

  it("clamps floating-point samples to signed 16-bit PCM", () => {
    const output: Int16Array[] = [];
    const resampler = new PcmResampler(16_000, 16_000, (frame) => {
      output.push(frame);
    });

    resampler.push(Float32Array.from([-2, -1, 0, 1, 2]));
    resampler.flush();

    expect(Array.from(output[0] ?? [])).toEqual([
      -32_768, -32_768, 0, 32_767, 32_767,
    ]);
  });
});

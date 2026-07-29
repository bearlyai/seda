import { SedaError, type TranscriptUpdate } from "@bearlyai/seda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/session.js";
import type { InferenceHost } from "../src/worker-host.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserSession", () => {
  it("emits revisable buffered text and a final transcript", async () => {
    vi.useFakeTimers();
    const transcribe = vi
      .fn<InferenceHost["transcribe"]>()
      .mockResolvedValueOnce("hello")
      .mockResolvedValueOnce("hello world");
    const updates: TranscriptUpdate[] = [];
    const session = new BrowserSession(
      "session-1",
      { transcribe },
      { language: "en", partialIntervalMs: 250 },
      () => undefined,
    );
    session.on("transcript", (update) => {
      updates.push(update);
    });

    session.write(new Int16Array(16_000).fill(8_192));
    await vi.advanceTimersByTimeAsync(250);

    expect(updates).toEqual([
      expect.objectContaining({
        revision: 1,
        text: "hello",
        stableText: "",
        unstableText: "hello",
        final: false,
      }),
    ]);

    session.write(new Int16Array(8_000).fill(4_096));
    const transcript = await session.commit();

    expect(transcript).toEqual({
      text: "hello world",
      words: [],
      language: "en",
      durationMs: 1_500,
    });
    expect(updates.at(-1)).toEqual(
      expect.objectContaining({
        revision: 2,
        text: "hello world",
        stableText: "hello world",
        unstableText: "",
        final: true,
      }),
    );
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]?.[0]).toHaveLength(24_000);
  });

  it("accepts little-endian PCM bytes and owns the audio", async () => {
    const transcribe = vi
      .fn<InferenceHost["transcribe"]>()
      .mockImplementation(async (audio) =>
        Array.from(audio)
          .map((sample) => sample.toFixed(4))
          .join(","),
      );
    const session = new BrowserSession(
      "session-2",
      { transcribe },
      {},
      () => undefined,
    );
    const bytes = Uint8Array.from([0x00, 0x40, 0x00, 0xc0]);
    session.write(bytes);
    bytes.fill(0);

    const transcript = await session.commit();

    expect(transcript.text).toBe("0.5000,-0.5000");
  });

  it("cancels without waiting for an active inference", async () => {
    vi.useFakeTimers();
    let resolveInference: ((value: string) => void) | undefined;
    const transcribe = vi.fn<InferenceHost["transcribe"]>(
      () =>
        new Promise<string>((resolve) => {
          resolveInference = resolve;
        }),
    );
    const session = new BrowserSession(
      "session-3",
      { transcribe },
      { partialIntervalMs: 250 },
      () => undefined,
    );
    session.write(new Int16Array(16_000));
    await vi.advanceTimersByTimeAsync(250);

    await expect(session.cancel()).resolves.toBeUndefined();
    resolveInference?.("ignored");
    await vi.runAllTimersAsync();
    await expect(session.commit()).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("enforces a bounded per-session audio buffer", () => {
    const session = new BrowserSession(
      "session-4",
      { transcribe: async () => "" },
      { maxAudioSeconds: 1 },
      () => undefined,
    );

    expect(() => session.write(new Int16Array(16_001))).toThrowError(
      SedaError,
    );
    expect(() => session.write(new Int16Array(1))).toThrow(
      "cannot write after",
    );
  });

  it("rejects unsupported tuning values", () => {
    expect(
      () =>
        new BrowserSession(
          "session-5",
          { transcribe: async () => "" },
          { partialIntervalMs: 1 },
          () => undefined,
        ),
    ).toThrow("partialIntervalMs must be an integer from 250 to 5000");
  });
});


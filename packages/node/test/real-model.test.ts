import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SedaNode } from "../src/index.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(packageDirectory, "../../..");
const binary =
  process.env["SEDA_TEST_BINARY"] ??
  resolve(
    workspace,
    "target/debug",
    process.platform === "win32" ? "seda.exe" : "seda",
  );
const audio =
  process.env["SEDA_REAL_AUDIO"] ??
  resolve(workspace, ".seda/fixtures/speech.wav");

let running: SedaNode | undefined;

beforeAll(async () => {
  if (process.env["SEDA_REAL_MODEL"] === "1") {
    await Promise.all([access(binary), access(audio)]);
  }
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("Seda with the pinned native runtime and compact model", () => {
  it.skipIf(process.env["SEDA_REAL_MODEL"] !== "1")(
    "streams a verified speech fixture end to end",
    async () => {
      running = await SedaNode.start({
        binaryPath: binary,
        profile: "compact",
        language: "en",
        ...(process.env["SEDA_HOME"]
          ? { dataDirectory: process.env["SEDA_HOME"] }
          : {}),
        startupTimeoutMs: 60_000,
      });

      const session = await running.listen({ language: "en" });
      const partials: string[] = [];
      session.on("transcript", ({ text, final }) => {
        if (!final) {
          partials.push(text);
        }
      });

      const pcm = readPcm16Mono(await readFile(audio));
      for (let offset = 0; offset < pcm.length; offset += 1_600) {
        session.write(pcm.subarray(offset, offset + 1_600));
      }
      const transcript = await session.commit();

      expect(transcript.text).toBe(
        "well i don't wish to see it any more observed phoebe turning away her eyes it is certainly very like the old portrait",
      );
      expect(partials.length).toBeGreaterThan(0);
      expect(transcript.words.length).toBeGreaterThan(0);
      expect(transcript.words.at(-1)?.text).toBe("portrait");
    },
    120_000,
  );
});

function readPcm16Mono(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (ascii(wav, 0, 4) !== "RIFF" || ascii(wav, 8, 4) !== "WAVE") {
    throw new Error("fixture is not a RIFF/WAVE file");
  }

  let format: { channels: number; sampleRate: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= wav.byteLength; ) {
    const id = ascii(wav, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > wav.byteLength) {
      throw new Error("fixture contains a truncated WAV chunk");
    }
    if (id === "fmt ") {
      if (view.getUint16(body, true) !== 1) {
        throw new Error("fixture must use integer PCM");
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = wav.subarray(body, body + length);
    }
    offset = body + length + (length % 2);
  }

  if (
    format?.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bits !== 16 ||
    !data
  ) {
    throw new Error("fixture must be 16 kHz mono 16-bit PCM");
  }
  const owned = new Uint8Array(data.byteLength);
  owned.set(data);
  return new Int16Array(owned.buffer);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

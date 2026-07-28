import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Seda } from "../src/index.js";
import type { TranscriptUpdate, WebSocketLike } from "../src/index.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(packageDirectory, "../../..");
const binary =
  process.env["SEDA_TEST_BINARY"] ??
  resolve(
    workspace,
    "target/debug",
    process.platform === "win32" ? "seda.exe" : "seda",
  );

let processHandle: ChildProcessWithoutNullStreams;
let client: Seda;

beforeAll(async () => {
  await access(binary);
  processHandle = spawn(
    binary,
    ["serve", "--engine", "fixture", "--listen", "127.0.0.1:0"],
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const line = await new Promise<string>((resolveLine, reject) => {
    const lines = createInterface({ input: processHandle.stdout });
    lines.once("line", resolveLine);
    processHandle.once("exit", (code) => {
      reject(new Error(`Seda exited before startup with code ${code}`));
    });
  });
  const ready = JSON.parse(line) as {
    address: string;
    token: string;
  };
  client = await Seda.connect({
    baseUrl: `http://${ready.address}`,
    token: ready.token,
    webSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
});

afterAll(() => {
  processHandle?.kill("SIGTERM");
});

describe("Seda client", () => {
  it("negotiates capabilities through the real daemon", async () => {
    const capabilities = await client.capabilities();
    expect(capabilities.runtime).toBe("fixture");
    expect(capabilities.streaming).toBe("true");
  });

  it("streams revisable updates and resolves commit with the final transcript", async () => {
    const session = await client.listen({ language: "en" });
    const updates: TranscriptUpdate[] = [];
    session.on("transcript", (update) => updates.push(update));

    session.write(new Int16Array(160));
    session.write(new Int16Array(160));
    const completion = session.commit();
    const duplicateCommit = session.commit();
    expect(() => session.write(new Int16Array(1))).toThrow(
      "cannot write after a session is committed",
    );
    const [final, duplicateFinal] = await Promise.all([
      completion,
      duplicateCommit,
    ]);

    expect(updates.map(({ text, final }) => ({ text, final }))).toEqual([
      { text: "hello", final: false },
      { text: "hello world", final: false },
      { text: "hello world", final: true },
    ]);
    expect(final.text).toBe("hello world");
    expect(duplicateFinal).toEqual(final);
    expect(final.words).toHaveLength(2);
  });
});

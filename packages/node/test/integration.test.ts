import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

let running: SedaNode | undefined;

beforeAll(async () => {
  await access(binary);
  process.env["SEDA_INTERNAL_TEST_ENGINE"] = "fixture";
});

afterAll(() => {
  delete process.env["SEDA_INTERNAL_TEST_ENGINE"];
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("SedaNode", () => {
  it("fails cleanly when the configured sidecar cannot be launched", async () => {
    await expect(
      SedaNode.start({
        binaryPath: resolve(workspace, "does-not-exist", "seda"),
        startupTimeoutMs: 100,
      }),
    ).rejects.toThrow();
  });

  it("owns the full sidecar lifecycle for Node and Electron main processes", async () => {
    running = await SedaNode.start({
      binaryPath: binary,
    });

    const session = await running.listen({ language: "en" });
    session.write(new Int16Array(160));
    session.write(new Int16Array(160));
    const transcript = await session.commit();

    expect(transcript.text).toBe("hello world");
    expect((await running.capabilities()).runtime).toBe("fixture");
  });
});

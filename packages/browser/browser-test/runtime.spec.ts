import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(directory, "fixture");
const workspace = resolve(directory, "../../..");
const realAudio =
  process.env["SEDA_REAL_AUDIO"] ??
  resolve(workspace, ".seda/fixtures/speech.wav");

let server: ViteDevServer;
let pageUrl: string;

test.beforeAll(async () => {
  server = await createServer({
    root: fixtureRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("browser runtime fixture did not bind a TCP port");
  }
  pageUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

test("runs microphone recognition entirely inside the browser", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the deterministic fake microphone is Chromium-specific",
  );
  const browserErrors = collectErrors(page);
  await page.route(/\/worker\.js(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: "text/javascript",
      body: fakeInferenceWorker(),
    });
  });

  await page.goto(pageUrl);
  const state = page.getByTestId("state");
  await expect(state, browserErrors.join("\n")).toHaveText("Ready");
  await expect(page.getByTestId("runtime")).toHaveText(
    "transformers.js/wasm",
  );
  await expect(page.getByTestId("progress")).toHaveText("ready:wasm");

  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(state, browserErrors.join("\n")).toHaveText("Listening");
  await expect(page.getByTestId("live")).toContainText("hello");

  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(state, browserErrors.join("\n")).toHaveText("Complete");
  await expect(page.getByTestId("final")).toHaveText("hello world");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__sedaTracks.every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
  expect(browserErrors).toEqual([]);
});

test("keeps the in-process session API portable across browser engines", async ({
  page,
}) => {
  const browserErrors = collectErrors(page);
  await page.route(/\/worker\.js(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: "text/javascript",
      body: fakeInferenceWorker(),
    });
  });

  await page.goto(pageUrl);
  await expect(page.getByTestId("state"), browserErrors.join("\n")).toHaveText(
    "Ready",
  );
  const result = await page.evaluate(async () => {
    const revisions: Array<{ text: string; final: boolean }> = [];
    const session = await window.__sedaBrowser.listen({ language: "en" });
    session.on("transcript", ({ text, final }) => {
      revisions.push({ text, final });
    });
    session.write(new Int16Array(16_000).fill(1_024));
    const transcript = await session.commit();
    return { transcript, revisions };
  });

  expect(result.transcript.text).toBe("hello");
  expect(result.revisions).toEqual([{ text: "hello", final: true }]);
  expect(browserErrors).toEqual([]);
});

test("closing the browser runtime releases an active microphone", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the deterministic fake microphone is Chromium-specific",
  );
  const browserErrors = collectErrors(page);
  await page.route(/\/worker\.js(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: "text/javascript",
      body: fakeInferenceWorker(),
    });
  });

  await page.goto(pageUrl);
  await expect(page.getByTestId("state"), browserErrors.join("\n")).toHaveText(
    "Ready",
  );
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByTestId("state")).toHaveText("Listening");
  await page.evaluate(() => window.__sedaBrowser.close());

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__sedaTracks.every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
  expect(browserErrors).toEqual([]);
});

test("transcribes with the real Moonshine WASM model", async ({
  page,
  browserName,
}) => {
  test.skip(
    process.env["SEDA_REAL_BROWSER_MODEL"] !== "1" ||
      browserName !== "chromium",
    "the real model lane runs in Chromium when SEDA_REAL_BROWSER_MODEL=1",
  );
  test.setTimeout(240_000);
  const browserErrors = collectErrors(page);
  const runtimeCdnRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "cdn.jsdelivr.net") {
      runtimeCdnRequests.push(request.url());
    }
  });
  await page.route("**/speech.wav", async (route) => {
    await route.fulfill({
      contentType: "audio/wav",
      body: await readFile(realAudio),
    });
  });

  await page.goto(`${pageUrl}?device=wasm`);
  const state = page.getByTestId("state");
  await expect(state, browserErrors.join("\n")).toHaveText("Ready", {
    timeout: 180_000,
  });
  await page.getByRole("button", { name: "Transcribe fixture" }).click();
  await expect(state, browserErrors.join("\n")).toHaveText(
    "Fixture complete",
    { timeout: 60_000 },
  );
  const transcript = await page.getByTestId("final").textContent();
  expect(transcript?.toLowerCase()).toMatch(/phoebe|portrait|observed/);
  expect(runtimeCdnRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

function collectErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}

function fakeInferenceWorker(): string {
  return `
let calls = 0;
self.addEventListener("message", ({ data }) => {
  if (data.type === "load") {
    if (data.device !== "auto") {
      self.postMessage({
        type: "error",
        requestId: data.requestId,
        message: "expected the portable auto device policy",
      });
      return;
    }
    self.postMessage({
      type: "progress",
      progress: { stage: "ready", device: "wasm", message: "Ready on wasm" },
    });
    self.postMessage({
      type: "loaded",
      requestId: data.requestId,
      device: "wasm",
    });
    return;
  }
  calls += 1;
  self.postMessage({
    type: "result",
    requestId: data.requestId,
    text: calls === 1 ? "hello" : "hello world",
  });
});
`;
}

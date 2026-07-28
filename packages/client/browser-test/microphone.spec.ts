import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(directory, "../../..");
const clientDist = resolve(directory, "../dist");
const binary =
  process.env["SEDA_TEST_BINARY"] ??
  resolve(
    workspace,
    "target/debug",
    process.platform === "win32" ? "seda.exe" : "seda",
  );

let webServer: Server;
let sedaProcess: ChildProcessWithoutNullStreams;
let pageUrl: string;
let service: { address: string; token: string };

test.beforeAll(async () => {
  webServer = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(testPage(service));
        return;
      }
      const match = /^\/seda\/([a-z-]+\.js)$/.exec(request.url ?? "");
      if (!match?.[1]) {
        response.writeHead(404).end();
        return;
      }
      const file = resolve(clientDist, match[1]);
      if (extname(file) !== ".js" || dirname(file) !== clientDist) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolveListen) => {
    webServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = webServer.address();
  if (!address || typeof address === "string") {
    throw new Error("browser fixture server did not bind a TCP port");
  }
  pageUrl = `http://127.0.0.1:${address.port}`;

  sedaProcess = spawn(
    binary,
    [
      "serve",
      "--engine",
      "fixture",
      "--listen",
      "127.0.0.1:0",
      "--allow-origin",
      pageUrl,
    ],
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: sedaProcess.stdout });
  const readyLine = await new Promise<string>((resolveLine, reject) => {
    lines.once("line", resolveLine);
    sedaProcess.once("exit", (code) => {
      reject(new Error(`Seda exited before startup with code ${code}`));
    });
  });
  service = JSON.parse(readyLine) as { address: string; token: string };
});

test.afterAll(async () => {
  sedaProcess?.kill("SIGTERM");
  await new Promise<void>((resolveClose, reject) => {
    webServer?.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolveClose();
      }
    });
  });
});

test("captures the browser microphone and streams a final transcript", async ({
  page,
}) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Start listening" }).click();

  await expect(page.getByTestId("state")).toHaveText("Listening");
  await expect(page.getByTestId("live")).toHaveText("hello world");
  await page.getByRole("button", { name: "Stop listening" }).click();

  await expect(page.getByTestId("state")).toHaveText("Complete");
  await expect(page.getByTestId("final")).toHaveText("hello world");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tracks = (
          window as unknown as { __sedaTracks: MediaStreamTrack[] }
        ).__sedaTracks;
        return tracks.every((track) => track.readyState === "ended");
      }),
    )
    .toBe(true);
});

function testPage(ready: { address: string; token: string }): string {
  const connection = JSON.stringify({
    baseUrl: `http://${ready.address}`,
    token: ready.token,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <body>
    <button id="start">Start listening</button>
    <button id="stop" disabled>Stop listening</button>
    <p data-testid="state">Ready</p>
    <p data-testid="live"></p>
    <p data-testid="final"></p>
    <script type="module">
      import { Seda } from "/seda/index.js";
      const seda = await Seda.connect(${connection});
      let microphone;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await getUserMedia(constraints);
        window.__sedaTracks = stream.getTracks();
        return stream;
      };
      const state = document.querySelector('[data-testid="state"]');
      const live = document.querySelector('[data-testid="live"]');
      const final = document.querySelector('[data-testid="final"]');
      const start = document.querySelector("#start");
      const stop = document.querySelector("#stop");

      start.addEventListener("click", async () => {
        microphone = await seda.microphone({
          language: "en",
          onTranscript: (update) => {
            live.textContent = update.text;
          },
        });
        state.textContent = "Listening";
        start.disabled = true;
        stop.disabled = false;
      });

      stop.addEventListener("click", async () => {
        const transcript = await microphone.stop();
        final.textContent = transcript.text;
        state.textContent = "Complete";
        stop.disabled = true;
      });
    </script>
  </body>
</html>`;
}

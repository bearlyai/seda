import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import WebSocket from "ws";
import {
  Seda,
  type Capabilities,
  type ListenOptions,
  type Session,
  type Transcript,
  type WebSocketLike,
} from "@bearlyai/seda";

export type { ListenOptions, Profile, TranscriptUpdate } from "@bearlyai/seda";

export interface RuntimeOptions {
  binaryPath?: string;
  profile?: "compact" | "balanced" | "quality";
  language?: string;
  dataDirectory?: string;
}

export interface PrepareProgress {
  type:
    | "resolving"
    | "downloading"
    | "verifying"
    | "installing"
    | "ready"
    | "prepared";
  id?: string;
  completedBytes?: number;
  totalBytes?: number;
  model?: string;
  path?: string;
}

export interface PrepareOptions extends RuntimeOptions {
  onProgress?: (progress: PrepareProgress) => void;
  signal?: AbortSignal;
}

export interface StartOptions extends RuntimeOptions {
  allowedOrigins?: string[];
  startupTimeoutMs?: number;
}

export class SedaNode {
  readonly client: Seda;
  readonly address: string;

  readonly #process: ChildProcessWithoutNullStreams;
  #closed = false;

  private constructor(
    processHandle: ChildProcessWithoutNullStreams,
    address: string,
    client: Seda,
  ) {
    this.#process = processHandle;
    this.address = address;
    this.client = client;
  }

  static async prepare(options: PrepareOptions = {}): Promise<void> {
    const arguments_ = [
      "prepare",
      "--profile",
      options.profile ?? "balanced",
      "--language",
      options.language ?? "auto",
      "--jsonl",
    ];
    const child = spawnBinary(options, arguments_);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        options.onProgress?.(JSON.parse(line) as PrepareProgress);
      } catch {
        // Only stable JSONL output is forwarded to callers.
      }
    });
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const stderr = collectLines(child.stderr);
    let code: number | null;
    try {
      [code] = (await once(child, "exit")) as [number | null];
    } finally {
      options.signal?.removeEventListener("abort", abort);
      lines.close();
    }
    if (options.signal?.aborted) {
      throw new DOMException("model preparation was aborted", "AbortError");
    }
    if (code !== 0) {
      throw new Error(
        `seda prepare exited with code ${String(code)}\n${stderr.join("\n")}`,
      );
    }
  }

  static async start(options: StartOptions = {}): Promise<SedaNode> {
    const arguments_ = [
      "serve",
      "--profile",
      options.profile ?? "balanced",
      "--language",
      options.language ?? "auto",
      "--listen",
      "127.0.0.1:0",
      "--engine",
      process.env["SEDA_INTERNAL_TEST_ENGINE"] === "fixture"
        ? "fixture"
        : "parakeet",
    ];
    for (const origin of options.allowedOrigins ?? []) {
      arguments_.push("--allow-origin", origin);
    }
    const child = spawnBinary(options, arguments_);
    const stderr = collectLines(child.stderr);
    const timeoutMs = options.startupTimeoutMs ?? 30_000;
    let ready: { address: string; token: string };
    try {
      ready = await readReady(child, timeoutMs, stderr);
    } catch (error) {
      child.kill();
      throw error;
    }
    try {
      const client = await Seda.connect({
        baseUrl: `http://${ready.address}`,
        token: ready.token,
        webSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      });
      return new SedaNode(child, ready.address, client);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  capabilities(): Promise<Capabilities> {
    return this.client.capabilities();
  }

  listen(options?: ListenOptions): Promise<Session> {
    return this.client.listen(options);
  }

  transcribe(
    wav: Blob | ArrayBuffer | ArrayBufferView,
    options?: { language?: string },
  ): Promise<Transcript> {
    return this.client.transcribe(wav, options);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (
      this.#process.exitCode !== null ||
      this.#process.signalCode !== null
    ) {
      return;
    }
    const exited = once(this.#process, "exit");
    this.#process.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 5_000).unref();
    });
    if ((await Promise.race([exited, timeout])) === "timeout") {
      this.#process.kill("SIGKILL");
      await once(this.#process, "exit");
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function spawnBinary(
  options: RuntimeOptions,
  arguments_: string[],
): ChildProcessWithoutNullStreams {
  const environment = { ...process.env };
  if (options.dataDirectory) {
    environment["SEDA_HOME"] = options.dataDirectory;
  }
  return spawn(
    options.binaryPath ?? process.env["SEDA_BINARY"] ?? "seda",
    arguments_,
    {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

function collectLines(
  stream: NodeJS.ReadableStream,
  maximum = 20,
): string[] {
  const output: string[] = [];
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    output.push(line);
    if (output.length > maximum) {
      output.shift();
    }
  });
  return output;
}

async function readReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  stderr: string[],
): Promise<{ address: string; token: string }> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      finish(new Error(`Seda did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();

    const finish = (
      error?: unknown,
      value?: { address: string; token: string },
    ) => {
      clearTimeout(timeout);
      lines.close();
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => {
      finish(
        new Error(
          `Seda exited before startup with code ${String(code)}\n${stderr.join("\n")}`,
        ),
      );
    };

    lines.once("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          type?: string;
          address?: string;
          token?: string;
        };
        if (
          message.type !== "ready" ||
          !message.address ||
          !message.token
        ) {
          throw new Error("invalid readiness message");
        }
        finish(undefined, {
          address: message.address,
          token: message.token,
        });
      } catch (cause) {
        finish(
          new Error(`Seda emitted invalid startup data: ${line}`, { cause }),
        );
      }
    });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

import { SedaBrowser } from "@bearlyai/seda-browser";
import type { MicrophoneSession } from "@bearlyai/seda";

const state = required("[data-testid=state]");
const runtimeName = required("[data-testid=runtime]");
const progress = required("[data-testid=progress]");
const live = required("[data-testid=live]");
const final = required("[data-testid=final]");
const start = requiredButton("#start");
const stop = requiredButton("#stop");
const fixture = requiredButton("#fixture");

let microphone: MicrophoneSession | undefined;

try {
  const requestedDevice = new URLSearchParams(location.search).get("device");
  const seda = await SedaBrowser.prepare({
    ...(requestedDevice === "wasm" ? { device: "wasm" as const } : {}),
    onProgress: (update) => {
      progress.textContent = `${update.stage}:${update.device ?? ""}`;
    },
  });
  const capabilities = await seda.capabilities();
  runtimeName.textContent = capabilities.runtime;

  start.addEventListener("click", async () => {
    try {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await getUserMedia(constraints);
        window.__sedaTracks = stream.getTracks();
        return stream;
      };
      microphone = await seda.microphone({
        language: "en",
        partialIntervalMs: 250,
        onTranscript: (update) => {
          live.textContent = update.text;
        },
      });
      state.textContent = "Listening";
      start.disabled = true;
      stop.disabled = false;
    } catch (error) {
      reportError(error);
    }
  });

  stop.addEventListener("click", async () => {
    if (!microphone) return;
    try {
      const transcript = await microphone.stop();
      microphone = undefined;
      final.textContent = transcript.text;
      state.textContent = "Complete";
      stop.disabled = true;
      start.disabled = false;
    } catch (error) {
      reportError(error);
    }
  });

  fixture.addEventListener("click", async () => {
    try {
      state.textContent = "Transcribing fixture";
      const response = await fetch("/speech.wav");
      if (!response.ok) {
        throw new Error(`fixture request failed with ${response.status}`);
      }
      const session = await seda.listen({
        language: "en",
        partialIntervalMs: 5_000,
      });
      session.write(wavPcm(await response.arrayBuffer()));
      const transcript = await session.commit();
      final.textContent = transcript.text;
      state.textContent = "Fixture complete";
    } catch (error) {
      reportError(error);
    }
  });

  window.__sedaBrowser = seda;
  state.textContent = "Ready";
  start.disabled = false;
  fixture.disabled = false;
} catch (error) {
  reportError(error);
}

function wavPcm(wav: ArrayBuffer): Int16Array {
  const view = new DataView(wav);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new Error("fixture is not a WAV file");
  }
  let offset = 12;
  let format:
    | { encoding: number; channels: number; sampleRate: number; bits: number }
    | undefined;
  let data: { offset: number; length: number } | undefined;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    }
    if (id === "data") {
      data = { offset: body, length };
      break;
    }
    offset = body + length + (length % 2);
  }
  if (
    !format ||
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bits !== 16 ||
    !data ||
    data.length % 2 !== 0
  ) {
    throw new Error("fixture must be 16 kHz mono signed 16-bit PCM");
  }
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(data.offset + index * 2, true);
  }
  return samples;
}

function ascii(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(
    ...Array.from(
      { length },
      (_, index) => view.getUint8(offset + index),
    ),
  );
}

function required(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function requiredButton(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.textContent = `Error: ${message}`;
  window.__sedaError = message;
  console.error(error);
}

declare global {
  interface Window {
    __sedaBrowser: SedaBrowser;
    __sedaError?: string;
    __sedaTracks: MediaStreamTrack[];
  }
}

import { clientError, SedaError } from "./error.js";
import type {
  MicrophoneOptions,
  ServerEvent,
  SessionEventMap,
  SessionListener,
  Transcript,
  TranscriptionSession,
} from "./types.js";

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const WORKLET_NAME = "seda-microphone-capture";
const WORKLET_SOURCE = `
class SedaMicrophoneCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) {
      return true;
    }
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let index = 0; index < mono.length; index += 1) {
        mono[index] += channel[index] / channels.length;
      }
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", SedaMicrophoneCapture);
`;

/**
 * A live browser microphone connected to a Seda streaming session.
 *
 * Call `stop()` when push-to-talk is released. It stops every media track,
 * closes the audio graph, commits the recognizer, and resolves with the final
 * transcript.
 */
export class MicrophoneSession {
  readonly id: string;
  readonly events: AsyncIterable<ServerEvent>;

  readonly #session: TranscriptionSession;
  readonly #stream: MediaStream;
  readonly #context: AudioContext;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #capture: AudioWorkletNode;
  readonly #sink: GainNode;
  readonly #resampler: PcmResampler;
  readonly #abortSignal: AbortSignal | undefined;
  readonly #abort: () => void;
  readonly #onRelease: (() => void) | undefined;

  #closed = false;
  #stopPromise: Promise<Transcript> | undefined;
  #cancelPromise: Promise<void> | undefined;

  private constructor(
    session: TranscriptionSession,
    stream: MediaStream,
    context: AudioContext,
    source: MediaStreamAudioSourceNode,
    capture: AudioWorkletNode,
    sink: GainNode,
    options: MicrophoneOptions,
    onRelease?: () => void,
  ) {
    this.id = session.id;
    this.events = session.events;
    this.#session = session;
    this.#stream = stream;
    this.#context = context;
    this.#source = source;
    this.#capture = capture;
    this.#sink = sink;
    this.#resampler = new PcmResampler(
      context.sampleRate,
      TARGET_SAMPLE_RATE,
      (pcm) => {
        if (!this.#closed) {
          this.#session.write(pcm);
        }
      },
    );
    this.#abortSignal = options.signal;
    this.#abort = () => {
      void this.cancel();
    };
    this.#onRelease = onRelease;

    capture.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!this.#closed && data instanceof Float32Array) {
        this.#resampler.push(data);
      }
    };
    for (const track of stream.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (!this.#closed) {
            void this.cancel();
          }
        },
        { once: true },
      );
    }
    if (options.onTranscript) {
      session.on("transcript", options.onTranscript);
    }
    options.signal?.addEventListener("abort", this.#abort, { once: true });
  }

  static async start(
    createSession: () => Promise<TranscriptionSession>,
    options: MicrophoneOptions,
    onRelease?: () => void,
  ): Promise<MicrophoneSession> {
    if (options.signal?.aborted) {
      throw new DOMException("microphone capture was aborted", "AbortError");
    }

    const mediaDevices = globalThis.navigator?.mediaDevices;
    const AudioContextConstructor = globalThis.AudioContext;
    if (!mediaDevices?.getUserMedia || !AudioContextConstructor) {
      throw new SedaError({
        code: "unsupported_hardware",
        message:
          "microphone capture requires a secure page with getUserMedia and AudioContext",
        recoverable: false,
      });
    }

    let stream: MediaStream | undefined;
    let session: TranscriptionSession | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: microphoneConstraints(options),
      });
      session = await createSession();
      context = new AudioContextConstructor({ latencyHint: "interactive" });
      if (!context.audioWorklet) {
        throw new SedaError({
          code: "unsupported_hardware",
          message: "this browser does not support AudioWorklet",
          recoverable: false,
        });
      }

      const moduleUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }

      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, WORKLET_NAME, {
        channelCount: 1,
        channelCountMode: "explicit",
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(capture).connect(sink).connect(context.destination);
      await context.resume();

      return new MicrophoneSession(
        session,
        stream,
        context,
        source,
        capture,
        sink,
        options,
        onRelease,
      );
    } catch (cause) {
      stopTracks(stream);
      if (context && context.state !== "closed") {
        await context.close().catch(() => undefined);
      }
      await session?.cancel().catch(() => undefined);
      throw microphoneError(cause);
    }
  }

  on<K extends keyof SessionEventMap>(
    type: K,
    listener: SessionListener<K>,
  ): () => void {
    return this.#session.on(type, listener);
  }

  /**
   * Stops capture and resolves after Seda emits the final transcript.
   */
  stop(): Promise<Transcript> {
    if (this.#cancelPromise) {
      return Promise.reject(
        new SedaError({
          code: "cancelled",
          message: "microphone session was cancelled",
          recoverable: true,
        }),
      );
    }
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  /**
   * Stops capture and discards the in-progress recognition session.
   */
  cancel(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise.then(() => undefined);
    }
    this.#cancelPromise ??= this.#cancel();
    return this.#cancelPromise;
  }

  async #stop(): Promise<Transcript> {
    this.#resampler.flush();
    this.#closed = true;
    await this.#release();
    return this.#session.commit();
  }

  async #cancel(): Promise<void> {
    this.#closed = true;
    await this.#release();
    await this.#session.cancel();
  }

  async #release(): Promise<void> {
    try {
      this.#abortSignal?.removeEventListener("abort", this.#abort);
      this.#capture.port.onmessage = null;
      this.#source.disconnect();
      this.#capture.disconnect();
      this.#sink.disconnect();
      stopTracks(this.#stream);
      if (this.#context.state !== "closed") {
        await this.#context.close();
      }
    } finally {
      this.#onRelease?.();
    }
  }
}

function microphoneConstraints(options: MicrophoneOptions): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? true,
    ...(options.deviceId
      ? { deviceId: { exact: options.deviceId } }
      : {}),
  };
}

function stopTracks(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function microphoneError(cause: unknown): unknown {
  if (cause instanceof SedaError) {
    return cause;
  }
  if (!(cause instanceof DOMException)) {
    return cause;
  }
  if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
    return new SedaError(
      {
        code: "permission_denied",
        message:
          "microphone permission was denied; allow microphone access and try again",
        recoverable: true,
      },
      { cause },
    );
  }
  if (
    cause.name === "NotFoundError" ||
    cause.name === "OverconstrainedError" ||
    cause.name === "NotReadableError"
  ) {
    return new SedaError(
      {
        code: "audio_device_unavailable",
        message: "the requested microphone is unavailable",
        recoverable: true,
      },
      { cause },
    );
  }
  return cause;
}

export class PcmResampler {
  readonly #ratio: number;
  readonly #emit: (pcm: Int16Array) => void;
  readonly #frame = new Int16Array(FRAME_SAMPLES);

  #pending = new Float32Array(0);
  #position = 0;
  #frameLength = 0;

  constructor(
    inputSampleRate: number,
    outputSampleRate: number,
    emit: (pcm: Int16Array) => void,
  ) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0) {
      throw clientError("audio sample rates must be positive");
    }
    this.#ratio = inputSampleRate / outputSampleRate;
    this.#emit = emit;
  }

  push(input: Float32Array): void {
    if (input.length === 0) {
      return;
    }
    const samples = new Float32Array(this.#pending.length + input.length);
    samples.set(this.#pending);
    samples.set(input, this.#pending.length);

    while (this.#position + 1 < samples.length) {
      const before = Math.floor(this.#position);
      const after = before + 1;
      const fraction = this.#position - before;
      const first = samples[before] ?? 0;
      const second = samples[after] ?? first;
      this.#append(first + (second - first) * fraction);
      this.#position += this.#ratio;
    }

    const consumed = Math.min(Math.floor(this.#position), samples.length);
    this.#pending = samples.slice(consumed);
    this.#position -= consumed;
  }

  flush(): void {
    if (this.#pending.length > 0) {
      this.#append(this.#pending[0] ?? 0);
    }
    if (this.#frameLength > 0) {
      this.#emit(this.#frame.slice(0, this.#frameLength));
      this.#frameLength = 0;
    }
    this.#pending = new Float32Array(0);
    this.#position = 0;
  }

  #append(sample: number): void {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.#frame[this.#frameLength] = Math.round(
      clamped * (clamped < 0 ? 32_768 : 32_767),
    );
    this.#frameLength += 1;
    if (this.#frameLength === this.#frame.length) {
      this.#emit(this.#frame.slice());
      this.#frameLength = 0;
    }
  }
}

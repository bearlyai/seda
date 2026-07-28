# Model selection

Seda’s v0.1 catalog exposes three intent-level profiles rather than model file
names in application code.

| Profile | Pinned model | Artifact | Ready languages | Output |
| --- | --- | ---: | --- | --- |
| `compact` | Parakeet Realtime EOU 120M v1, Q4_K | 129,133,984 bytes | English | true streaming, EOU, word times |
| `balanced` | Nemotron 3.5 ASR Streaming 0.6B, Q4_K | 718,102,624 bytes | 32 locales | true streaming, punctuation, word times |
| `quality` | Nemotron 3.5 ASR Streaming 0.6B, Q8_0 | 983,696,512 bytes | 32 locales | same model, higher weight precision |

The compact model is attractive for push-to-talk because NVIDIA describes it
as a 120M-parameter cache-aware streaming recognizer with 80–160 ms latency and
explicit end-of-utterance output. It is English-only and intentionally has no
punctuation or capitalization:
<https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1>

Nemotron 3.5 is the multilingual default because it is cache-aware true
streaming, supports automatic language detection, and includes punctuation and
capitalization. Seda advertises only the 19 transcription-ready and 13
broad-coverage locales, not the eight adaptation-only tokenizer locales:
<https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>

The GGUF files are community quantizations from:
<https://huggingface.co/mudler/parakeet-cpp-gguf>

The pinned native runtime is parakeet.cpp v0.4.0:
<https://github.com/mudler/parakeet.cpp/tree/v0.4.0>

## Why one adapter first

Parakeet gives Seda a useful launch combination: a small English streaming
model, a genuinely streaming multilingual model, word timestamps, a compact C
ABI, and prebuilt libraries for the three initial OS targets. More adapters
would increase surface area before the protocol and product behavior are proven.

## Alternatives evaluated

### Moonshine Voice

Moonshine is the strongest next adapter. Its current project targets live
on-device use across desktop, mobile, embedded systems, and WASM, with models
from tiny constrained deployments through higher-accuracy variants:
<https://github.com/moonshine-ai/moonshine>

Why not v0.1: it introduces another model format, runtime distribution, license
set, language matrix, and streaming behavior. Seda’s engine boundary is
specifically shaped so Moonshine can be added without changing clients.

### sherpa-onnx

sherpa-onnx has the broadest deployment matrix: desktop, mobile, Node, embedded,
and WebAssembly, with both streaming and non-streaming recognizers:
<https://github.com/k2-fsa/sherpa-onnx>

Why not v0.1: it is a toolkit and model ecosystem rather than one curated model
experience. It is a good future adapter for WASM, ARM, mobile, and languages not
covered by the launch catalog.

### whisper.cpp

whisper.cpp is mature, portable, multilingual, and an excellent batch fallback:
<https://github.com/ggml-org/whisper.cpp>

Why not the default: its common “streaming” integrations repeatedly decode a
rolling buffer. That can be useful, but Seda reports it as buffered streaming
rather than presenting it as the same behavior as a cache-aware streaming
recognizer.

## WASM feasibility

WASM is feasible, but “runs in a browser” is not the same as a production
push-to-talk experience:

- model download and persistent browser storage must be resumable and versioned;
- SIMD and threads depend on browser capabilities and cross-origin isolation;
- microphone capture needs AudioWorklet-based resampling and permission UX;
- low-memory mobile browsers can evict or fail large model allocations;
- the runtime must expose partial-revision and commit semantics consistent with
  the native API.

The likely path is a Moonshine or sherpa-onnx adapter behind a worker, with
OPFS/cache storage and the same TypeScript session API. Compact WASM will be a
separate capability tier, not a claim that every model runs on every browser.

## Licensing

Seda code is Apache-2.0. parakeet.cpp is MIT. The GGUF distribution identifies
itself as CC-BY-4.0. The compact base model uses NVIDIA’s Open Model License;
Nemotron 3.5 uses OpenMDW 1.1. Applications distributing or auto-downloading
weights must evaluate and retain the applicable upstream notices. Seda records
these licenses in `models/catalog.json` but does not provide legal advice.

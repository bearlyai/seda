# Model selection

Seda v0.2 exposes one browser profile and three native profiles. Applications
choose an intent-level tier rather than constructing model URLs.

| Runtime/profile | Pinned model | Download | Languages | Output |
| --- | --- | ---: | --- | --- |
| browser | Moonshine Tiny ONNX, FP32 encoder + Q8 decoder | ~55 MB | English | buffered revisions, punctuation |
| `compact` | Parakeet Realtime EOU 120M v1, Q4_K | 129,133,984 bytes | English | true streaming, EOU, word times |
| `balanced` | Nemotron 3.5 ASR Streaming 0.6B, Q4_K | 718,102,624 bytes | 32 locales | true streaming, punctuation, word times |
| `quality` | Nemotron 3.5 ASR Streaming 0.6B, Q8_0 | 983,696,512 bytes | 32 locales | same model, higher weight precision |

## Browser: Moonshine Tiny

`@bearlyai/seda-browser` pins
`onnx-community/moonshine-tiny-ONNX` at revision
`a6da1241cd305dcd64eab1edbd615f2bb9aabb95`. The English Moonshine model and
ONNX distribution are MIT licensed. Transformers.js 3.7.6 is Apache-2.0.

The Worker uses the full-precision encoder and Q8 merged decoder on WASM. WebGPU
uses a Q4 merged decoder. WebGPU is preferred automatically and WASM is the
portable fallback. The model is cached by the browser rather than placed in
Seda’s native data directory.

Moonshine Tiny is the browser default because its roughly 55 MB working set is
materially more deployable than the native Parakeet catalog and it has a proven
Transformers.js browser path. It is not cache-aware streaming: Seda periodically
decodes the current utterance, exposes those outputs as replaceable buffered
revisions, and performs a final decode on commit. One utterance is limited to
the model’s documented 30 seconds.

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

## Why Parakeet remains native

Parakeet gives Seda a useful launch combination: a small English streaming
model, a genuinely streaming multilingual model, word timestamps, a compact C
ABI, and prebuilt libraries for the three initial OS targets. More adapters
would increase surface area before the protocol and product behavior are proven.

## Alternatives evaluated

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

## Browser constraints

“Runs in a browser” does not mean every device has equal latency or memory:

- Cache API storage is persistent but browser eviction can require a reinstall.
- WebGPU availability and performance vary; WASM is the compatibility tier.
- Low-memory mobile browsers may fail the model allocation.
- The 30-second limit is enforced before memory can grow without bound.
- English is the only advertised browser language in v0.2.

The GitHub model lane downloads the pinned revision and recognizes a
checksum-verified real speech fixture through Chromium WASM. The regular browser
lane verifies the session contract in Chromium, Firefox, and WebKit.

## Licensing

Seda code and Transformers.js are Apache-2.0. English Moonshine and its ONNX
distribution are MIT. parakeet.cpp is MIT. The GGUF distribution identifies
itself as CC-BY-4.0. The compact base model uses NVIDIA’s Open Model License;
Nemotron 3.5 uses OpenMDW 1.1. Applications distributing or auto-downloading
weights must evaluate and retain the applicable upstream notices. Seda records
native licenses in `models/catalog.json` and browser pins in
`packages/browser/src/models.ts`, but does not provide legal advice.

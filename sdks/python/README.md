# Seda for Python

Typed Python 3.11+ client for a locally running Seda sidecar.

## Install

From a checkout:

```sh
python -m pip install ./sdks/python
```

From GitHub:

```sh
python -m pip install \
  "bearlyai-seda @ git+https://github.com/bearlyai/seda.git#subdirectory=sdks/python"
```

Prepare and start the native helper once:

```sh
seda prepare \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
seda serve \
  --model-id nvidia/nemotron-3.5-asr-streaming-0.6b \
  --variant q4_k
```

Read the first JSON stdout line and pass its `address` and `token` to the
client. Do not hard-code or persist that ephemeral token.

## Stream application-owned audio

Prepare and start Seda once, then choose the language for each transcription
or live stream:

```python
from seda import Seda

seda = Seda.connect("http://127.0.0.1:7331", token="...")
print(seda.capabilities().resolved_model.id)

with seda.listen(language="de-DE") as session:
    session.write(pcm_s16le)
    transcript = session.commit(
        on_transcript=lambda update: print(update.text, end="\r")
    )

print(transcript.text)
```

`write()` accepts raw 16 kHz, mono, signed 16-bit little-endian PCM bytes.
Transcript callbacks are revisions; render `update.text` as a replacement
rather than appending it.

## Transcribe a WAV file

For complete WAV files:

```python
with open("speech.wav", "rb") as audio:
    transcript = seda.transcribe(audio.read(), language="en-US")
```

## Build a language picker

```python
capabilities = seda.capabilities()
print(
    capabilities.resolved_model.id,
    capabilities.resolved_model.revision,
    capabilities.resolved_model.variant,
)

if capabilities.language.mode == "prompted":
    choices = capabilities.language.supported
```

The model is selected when the Seda process is prepared and started. Language
is selected independently for every call or stream. `SedaError` exposes stable
`code`, `recoverable`, and HTTP `status` fields.

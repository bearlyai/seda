import io
import os
import unittest
import wave

from seda import Seda


@unittest.skipUnless(
    os.environ.get("SEDA_TEST_BASE_URL") and os.environ.get("SEDA_TEST_TOKEN"),
    "set SEDA_TEST_BASE_URL and SEDA_TEST_TOKEN for the sidecar integration test",
)
class SidecarIntegrationTests(unittest.TestCase):
    def test_complete_and_live_protocol(self):
        seda = Seda.connect(
            os.environ["SEDA_TEST_BASE_URL"],
            os.environ["SEDA_TEST_TOKEN"],
        )
        self.assertEqual(seda.capabilities().resolved_model.id, "fixture/streaming-en")

        transcript = seda.transcribe(wav_fixture(), language="en")
        self.assertEqual(transcript.text, "hello world")

        session = seda.listen(language="en")
        session.write(b"\x00\x00" * 160)
        session.write(b"\x00\x00" * 160)
        updates = []
        transcript = session.commit(on_transcript=updates.append)
        self.assertEqual(transcript.text, "hello world")
        self.assertGreaterEqual(len(updates), 2)


def wav_fixture():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\x00\x00" * 320)
    return output.getvalue()

import json
import unittest
from urllib.request import Request

from seda import Seda


class FakeWebSocket:
    def __init__(self):
        self.binary = []
        self.text = []
        self.closed = False
        self.messages = iter(
            [
                json.dumps({"type": "ready", "session_id": "session-1"}),
                json.dumps(
                    {
                        "type": "transcript",
                        "segment_id": "session-1:0",
                        "revision": 1,
                        "text": "hallo",
                        "stable_text": "",
                        "unstable_text": "hallo",
                        "final": False,
                        "words": [],
                    }
                ),
                json.dumps(
                    {
                        "type": "completed",
                        "transcript": {
                            "text": "hallo welt",
                            "words": [],
                            "language": "de-DE",
                            "durationMs": 900,
                        },
                    }
                ),
            ]
        )

    def send_binary(self, payload):
        self.binary.append(payload)

    def send(self, payload):
        self.text.append(payload)

    def recv(self):
        return next(self.messages)

    def close(self):
        self.closed = True


class SedaTests(unittest.TestCase):
    def setUp(self):
        self.requests: list[Request] = []
        self.socket = FakeWebSocket()

        def http(request):
            self.requests.append(request)
            path = request.full_url
            if path.endswith("/v1/status"):
                return json.dumps(
                    {
                        "name": "seda",
                        "version": "0.2.0",
                        "protocol": 1,
                        "ready": True,
                    }
                ).encode()
            if path.endswith("/v1/capabilities"):
                return json.dumps(
                    {
                        "runtime": "fixture",
                        "model": "fixture/streaming-en",
                        "resolvedModel": {
                            "id": "fixture/streaming-en",
                            "revision": "test",
                            "variant": "fixture",
                            "runtime": "fixture",
                        },
                        "language": {
                            "mode": "prompted",
                            "supported": ["en-US", "de-DE"],
                            "supportsAuto": True,
                        },
                        "languages": ["en-US", "de-DE"],
                        "streaming": "true",
                        "punctuation": True,
                        "wordTimestamps": True,
                        "globalPushToTalk": False,
                        "focusedAppInsertion": False,
                    }
                ).encode()
            if path.endswith("/v1/sessions"):
                return json.dumps(
                    {
                        "id": "session-1",
                        "websocketPath": "/v1/sessions/session-1/stream",
                        "ticket": "ticket-1",
                    }
                ).encode()
            raise AssertionError(path)

        self.seda = Seda.connect(
            "http://127.0.0.1:7331",
            "token",
            http=http,
            websocket=lambda _url: self.socket,
        )

    def test_exposes_resolved_model_and_language_capabilities(self):
        capabilities = self.seda.capabilities()
        self.assertEqual(capabilities.resolved_model.id, "fixture/streaming-en")
        self.assertEqual(capabilities.language.mode, "prompted")
        self.assertTrue(capabilities.language.supports_auto)

    def test_selects_language_when_the_stream_starts(self):
        updates = []
        session = self.seda.listen(language="de-DE")
        session.write(b"\x00\x00" * 160)
        transcript = session.commit(on_transcript=updates.append)

        request = json.loads(self.requests[-1].data)
        self.assertEqual(request["language"], "de-DE")
        self.assertEqual(transcript.text, "hallo welt")
        self.assertEqual(updates[0].text, "hallo")
        self.assertEqual(self.socket.binary, [b"\x00\x00" * 160])
        self.assertEqual(json.loads(self.socket.text[-1]), {"type": "commit"})
        self.assertTrue(self.socket.closed)


if __name__ == "__main__":
    unittest.main()

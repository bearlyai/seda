"""Small, synchronous Seda client with stream-scoped language selection."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class Status:
    name: str
    version: str
    protocol: int
    ready: bool


@dataclass(frozen=True)
class ModelIdentity:
    id: str
    revision: str
    variant: str
    runtime: str


@dataclass(frozen=True)
class LanguageCapabilities:
    mode: str
    supported: tuple[str, ...]
    supports_auto: bool
    fixed: str | None = None


@dataclass(frozen=True)
class Capabilities:
    runtime: str
    resolved_model: ModelIdentity
    language: LanguageCapabilities
    streaming: str
    punctuation: bool
    word_timestamps: bool
    global_push_to_talk: bool
    focused_app_insertion: bool


@dataclass(frozen=True)
class Word:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None = None


@dataclass(frozen=True)
class Transcript:
    text: str
    words: tuple[Word, ...]
    duration_ms: int
    language: str | None = None


@dataclass(frozen=True)
class TranscriptUpdate:
    segment_id: str
    revision: int
    text: str
    stable_text: str
    unstable_text: str
    final: bool
    words: tuple[Word, ...]


class SedaError(RuntimeError):
    """Stable protocol or transport failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        recoverable: bool = False,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.status = status


class WebSocketLike(Protocol):
    def send_binary(self, payload: bytes) -> Any: ...

    def send(self, payload: str) -> Any: ...

    def recv(self) -> str | bytes: ...

    def close(self) -> Any: ...


WebSocketFactory = Callable[[str], WebSocketLike]
HttpTransport = Callable[[Request], bytes]


class Seda:
    """Authenticated client for a running local Seda service."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        http: HttpTransport | None = None,
        websocket: WebSocketFactory | None = None,
    ) -> None:
        if not token:
            raise ValueError("token is required")
        self._base_url = base_url.rstrip("/") + "/"
        self._token = token
        self._http = http or _urlopen
        self._websocket = websocket or _default_websocket

    @classmethod
    def connect(
        cls,
        base_url: str,
        token: str,
        **kwargs: Any,
    ) -> Seda:
        client = cls(base_url, token, **kwargs)
        status = client.status()
        if status.protocol != PROTOCOL_VERSION:
            raise SedaError(
                "invalid_request",
                f"unsupported Seda protocol {status.protocol}; "
                f"this client supports {PROTOCOL_VERSION}",
            )
        return client

    def status(self) -> Status:
        data = self._request("v1/status")
        return Status(
            name=str(data["name"]),
            version=str(data["version"]),
            protocol=int(data["protocol"]),
            ready=bool(data["ready"]),
        )

    def capabilities(self) -> Capabilities:
        data = self._request("v1/capabilities")
        model = _mapping(data["resolvedModel"])
        language = _mapping(data["language"])
        return Capabilities(
            runtime=str(data["runtime"]),
            resolved_model=ModelIdentity(
                id=str(model["id"]),
                revision=str(model["revision"]),
                variant=str(model["variant"]),
                runtime=str(model["runtime"]),
            ),
            language=LanguageCapabilities(
                mode=str(language["mode"]),
                supported=tuple(map(str, language.get("supported", []))),
                supports_auto=bool(language["supportsAuto"]),
                fixed=(
                    str(language["fixed"])
                    if language.get("fixed") is not None
                    else None
                ),
            ),
            streaming=str(data["streaming"]),
            punctuation=bool(data["punctuation"]),
            word_timestamps=bool(data["wordTimestamps"]),
            global_push_to_talk=bool(data["globalPushToTalk"]),
            focused_app_insertion=bool(data["focusedAppInsertion"]),
        )

    def transcribe(self, wav: bytes, *, language: str | None = None) -> Transcript:
        query = f"?{urlencode({'language': language})}" if language else ""
        data = self._request(
            f"v1/transcriptions{query}",
            method="POST",
            body=wav,
            content_type="audio/wav",
        )
        return _transcript(data)

    def listen(self, *, language: str | None = None) -> SedaSession:
        body: dict[str, Any] = {
            "input": {
                "encoding": "pcm_s16le",
                "sampleRate": 16_000,
                "channels": 1,
            }
        }
        if language is not None:
            body["language"] = language
        created = self._request(
            "v1/sessions",
            method="POST",
            body=json.dumps(body).encode(),
            content_type="application/json",
        )
        target = urljoin(self._base_url, str(created["websocketPath"]))
        parsed = urlparse(target)
        websocket_url = urlunparse(
            (
                "wss" if parsed.scheme == "https" else "ws",
                parsed.netloc,
                parsed.path,
                parsed.params,
                urlencode({"ticket": str(created["ticket"])}),
                parsed.fragment,
            )
        )
        return SedaSession(
            str(created["id"]),
            self._websocket(websocket_url),
        )

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> Mapping[str, Any]:
        headers = {"Authorization": f"Bearer {self._token}"}
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(
            urljoin(self._base_url, path),
            data=body,
            headers=headers,
            method=method,
        )
        try:
            payload = self._http(request)
        except HTTPError as error:
            payload = error.read()
            raise _response_error(payload, error.code) from error
        except URLError as error:
            raise SedaError(
                "runtime_failed",
                f"could not reach the Seda service: {error.reason}",
                recoverable=True,
            ) from error
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SedaError("runtime_failed", "Seda returned invalid JSON") from error
        return _mapping(decoded)


class SedaSession:
    """One language-scoped live transcription stream."""

    def __init__(self, session_id: str, websocket: WebSocketLike) -> None:
        self.id = session_id
        self._websocket = websocket
        self._settled = False

    def write(self, pcm_s16le: bytes | bytearray | memoryview) -> None:
        if self._settled:
            raise SedaError("invalid_audio", "session is already closed")
        self._websocket.send_binary(bytes(pcm_s16le))

    def events(self) -> Iterator[Mapping[str, Any]]:
        while not self._settled:
            payload = self._websocket.recv()
            if isinstance(payload, bytes):
                continue
            try:
                event = _mapping(json.loads(payload))
            except (json.JSONDecodeError, TypeError) as error:
                raise SedaError("runtime_failed", "invalid WebSocket event") from error
            yield event
            if event.get("type") in {"completed", "cancelled", "error"}:
                self._settled = True

    def commit(
        self,
        *,
        on_transcript: Callable[[TranscriptUpdate], None] | None = None,
    ) -> Transcript:
        if self._settled:
            raise SedaError("invalid_request", "session is already closed")
        self._websocket.send(json.dumps({"type": "commit"}))
        try:
            for event in self.events():
                event_type = event.get("type")
                if event_type == "transcript" and on_transcript:
                    on_transcript(_transcript_update(event))
                if event_type == "completed":
                    return _transcript(_mapping(event["transcript"]))
                if event_type == "error":
                    raise _event_error(event)
            raise SedaError("runtime_failed", "session closed without a transcript")
        finally:
            self._websocket.close()

    def cancel(self) -> None:
        if self._settled:
            return
        self._settled = True
        try:
            self._websocket.send(json.dumps({"type": "cancel"}))
        finally:
            self._websocket.close()

    def __enter__(self) -> SedaSession:
        return self

    def __exit__(self, *_: object) -> None:
        self.cancel()


def _urlopen(request: Request) -> bytes:
    with urlopen(request, timeout=30) as response:
        return response.read()


def _default_websocket(url: str) -> WebSocketLike:
    try:
        import websocket
    except ImportError as error:  # pragma: no cover - dependency is declared
        raise SedaError(
            "runtime_failed",
            "live sessions require the websocket-client package",
        ) from error
    # websocket-client otherwise adds a browser-style Origin header. Seda
    # intentionally denies browser origins unless a host explicitly allowlists
    # them; native SDK traffic must not impersonate a browser.
    return websocket.create_connection(url, timeout=30, suppress_origin=True)


def _mapping(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SedaError("runtime_failed", "Seda returned an unexpected value")
    return value


def _words(values: object) -> tuple[Word, ...]:
    if not isinstance(values, list):
        return ()
    return tuple(
        Word(
            text=str(word["text"]),
            start_ms=int(word["startMs"]),
            end_ms=int(word["endMs"]),
            confidence=(
                float(word["confidence"])
                if word.get("confidence") is not None
                else None
            ),
        )
        for item in values
        for word in [_mapping(item)]
    )


def _transcript(data: Mapping[str, Any]) -> Transcript:
    return Transcript(
        text=str(data["text"]),
        words=_words(data.get("words", [])),
        duration_ms=int(data["durationMs"]),
        language=(
            str(data["language"]) if data.get("language") is not None else None
        ),
    )


def _transcript_update(data: Mapping[str, Any]) -> TranscriptUpdate:
    return TranscriptUpdate(
        segment_id=str(data["segment_id"]),
        revision=int(data["revision"]),
        text=str(data["text"]),
        stable_text=str(data["stable_text"]),
        unstable_text=str(data["unstable_text"]),
        final=bool(data["final"]),
        words=_words(data.get("words", [])),
    )


def _response_error(payload: bytes, status: int) -> SedaError:
    try:
        body = _mapping(_mapping(json.loads(payload))["error"])
        return SedaError(
            str(body["code"]),
            str(body["message"]),
            recoverable=bool(body["recoverable"]),
            status=status,
        )
    except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return SedaError(
            "runtime_failed",
            f"Seda request failed with HTTP {status}",
            recoverable=status >= 500,
            status=status,
        )


def _event_error(event: Mapping[str, Any]) -> SedaError:
    body = _mapping(event["error"])
    return SedaError(
        str(body["code"]),
        str(body["message"]),
        recoverable=bool(body["recoverable"]),
    )

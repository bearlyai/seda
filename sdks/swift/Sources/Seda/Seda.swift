import Foundation

private let supportedProtocol = 1

public struct SedaStatus: Codable, Equatable, Sendable {
    public let name: String
    public let version: String
    public let `protocol`: Int
    public let ready: Bool
}

public struct SedaModelIdentity: Codable, Equatable, Sendable {
    public let id: String
    public let revision: String
    public let variant: String
    public let runtime: String
}

public struct SedaLanguageCapabilities: Codable, Equatable, Sendable {
    public let mode: String
    public let supported: [String]
    public let supportsAuto: Bool
    public let fixed: String?
}

public struct SedaCapabilities: Codable, Equatable, Sendable {
    public let runtime: String
    public let resolvedModel: SedaModelIdentity
    public let language: SedaLanguageCapabilities
    public let streaming: String
    public let punctuation: Bool
    public let wordTimestamps: Bool
    public let globalPushToTalk: Bool
    public let focusedAppInsertion: Bool
}

public struct SedaWord: Codable, Equatable, Sendable {
    public let text: String
    public let startMs: UInt64
    public let endMs: UInt64
    public let confidence: Float?
}

public struct SedaTranscript: Codable, Equatable, Sendable {
    public let text: String
    public let words: [SedaWord]
    public let language: String?
    public let durationMs: UInt64
}

public struct SedaTranscriptUpdate: Codable, Equatable, Sendable {
    public let segmentID: String
    public let revision: UInt64
    public let text: String
    public let stableText: String
    public let unstableText: String
    public let final: Bool
    public let words: [SedaWord]

    private enum CodingKeys: String, CodingKey {
        case segmentID = "segment_id"
        case revision
        case text
        case stableText = "stable_text"
        case unstableText = "unstable_text"
        case final
        case words
    }
}

public struct SedaError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public let message: String
    public let recoverable: Bool
    public let status: Int?

    public var errorDescription: String? { message }
}

public final class Seda: @unchecked Sendable {
    private let baseURL: URL
    private let token: String
    private let urlSession: URLSession
    private let socketFactory: @Sendable (URL) -> any SedaWebSocket
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private init(
        baseURL: URL,
        token: String,
        urlSession: URLSession,
        socketFactory: @escaping @Sendable (URL) -> any SedaWebSocket
    ) {
        self.baseURL = baseURL
        self.token = token
        self.urlSession = urlSession
        self.socketFactory = socketFactory
    }

    public static func connect(
        baseURL: URL,
        token: String,
        urlSession: URLSession = .shared
    ) async throws -> Seda {
        guard !token.isEmpty else {
            throw SedaError(
                code: "invalid_request",
                message: "A bearer token is required",
                recoverable: false,
                status: nil
            )
        }
        let client = Seda(
            baseURL: baseURL,
            token: token,
            urlSession: urlSession,
            socketFactory: { url in
                URLSessionSedaWebSocket(session: urlSession, url: url)
            }
        )
        let status = try await client.status()
        guard status.protocol == supportedProtocol else {
            throw SedaError(
                code: "invalid_request",
                message: "Unsupported Seda protocol \(status.protocol); "
                    + "this client supports \(supportedProtocol)",
                recoverable: false,
                status: nil
            )
        }
        return client
    }

    static func testing(
        baseURL: URL,
        token: String,
        urlSession: URLSession,
        socketFactory: @escaping @Sendable (URL) -> any SedaWebSocket
    ) -> Seda {
        Seda(
            baseURL: baseURL,
            token: token,
            urlSession: urlSession,
            socketFactory: socketFactory
        )
    }

    public func status() async throws -> SedaStatus {
        try await request(path: "v1/status")
    }

    public func capabilities() async throws -> SedaCapabilities {
        try await request(path: "v1/capabilities")
    }

    public func transcribe(
        wav: Data,
        language: String? = nil
    ) async throws -> SedaTranscript {
        var components = URLComponents()
        components.path = "v1/transcriptions"
        if let language {
            components.queryItems = [URLQueryItem(name: "language", value: language)]
        }
        return try await request(
            path: components.string ?? "v1/transcriptions",
            method: "POST",
            body: wav,
            contentType: "audio/wav"
        )
    }

    public func listen(language: String? = nil) async throws -> SedaSession {
        var body: [String: Any] = [
            "input": [
                "encoding": "pcm_s16le",
                "sampleRate": 16_000,
                "channels": 1,
            ],
        ]
        if let language {
            body["language"] = language
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        let created: SessionCreated = try await request(
            path: "v1/sessions",
            method: "POST",
            body: data,
            contentType: "application/json"
        )
        guard
            var components = URLComponents(
                url: created.websocketPath.hasPrefix("/")
                    ? URL(string: created.websocketPath, relativeTo: baseURL)!
                    : baseURL.appendingPathComponent(created.websocketPath),
                resolvingAgainstBaseURL: true
            )
        else {
            throw protocolError("Seda returned an invalid WebSocket path")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: created.ticket)]
        guard let socketURL = components.url else {
            throw protocolError("Seda returned an invalid WebSocket URL")
        }
        let socket = socketFactory(socketURL)
        socket.resume()
        return SedaSession(id: created.id, socket: socket)
    }

    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> T {
        guard let target = URL(string: path, relativeTo: baseURL) else {
            throw protocolError("Invalid Seda request URL")
        }
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw SedaError(
                code: "runtime_failed",
                message: "Could not reach the Seda service: \(error.localizedDescription)",
                recoverable: true,
                status: nil
            )
        }
        guard let http = response as? HTTPURLResponse else {
            throw protocolError("Seda returned a non-HTTP response")
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw decodeError(data, status: http.statusCode)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw protocolError("Seda returned invalid JSON")
        }
    }

    private func decodeError(_ data: Data, status: Int) -> SedaError {
        if
            let response = try? decoder.decode(ErrorEnvelope.self, from: data)
        {
            return SedaError(
                code: response.error.code,
                message: response.error.message,
                recoverable: response.error.recoverable,
                status: status
            )
        }
        return SedaError(
            code: "runtime_failed",
            message: "Seda request failed with HTTP \(status)",
            recoverable: status >= 500,
            status: status
        )
    }
}

public actor SedaSession {
    public nonisolated let id: String
    private let socket: any SedaWebSocket
    private let decoder = JSONDecoder()
    private var settled = false

    init(id: String, socket: any SedaWebSocket) {
        self.id = id
        self.socket = socket
    }

    public func write(_ pcmS16LE: Data) async throws {
        guard !settled else {
            throw protocolError("Session is already closed")
        }
        try await socket.send(.data(pcmS16LE))
    }

    public func commit(
        onTranscript: (@Sendable (SedaTranscriptUpdate) -> Void)? = nil
    ) async throws -> SedaTranscript {
        guard !settled else {
            throw protocolError("Session is already closed")
        }
        try await socket.send(.string(#"{"type":"commit"}"#))
        defer { close() }
        while true {
            let message = try await socket.receive()
            guard case let .string(text) = message, let data = text.data(using: .utf8)
            else {
                continue
            }
            let event: EventEnvelope
            do {
                event = try decoder.decode(EventEnvelope.self, from: data)
            } catch {
                throw protocolError("Seda returned an invalid live event")
            }
            switch event.type {
            case "transcript":
                if let onTranscript {
                    onTranscript(try decoder.decode(SedaTranscriptUpdate.self, from: data))
                }
            case "completed":
                guard let transcript = event.transcript else {
                    throw protocolError("Completed event has no transcript")
                }
                return transcript
            case "error":
                guard let error = event.error else {
                    throw protocolError("Malformed error event")
                }
                throw SedaError(
                    code: error.code,
                    message: error.message,
                    recoverable: error.recoverable,
                    status: nil
                )
            default:
                continue
            }
        }
    }

    public func cancel() async throws {
        guard !settled else { return }
        defer { close() }
        try await socket.send(.string(#"{"type":"cancel"}"#))
    }

    private func close() {
        settled = true
        socket.cancel()
    }
}

protocol SedaWebSocket: Sendable {
    func resume()
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    func cancel()
}

private final class URLSessionSedaWebSocket: SedaWebSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(session: URLSession, url: URL) {
        task = session.webSocketTask(with: url)
    }

    func resume() {
        task.resume()
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await task.send(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await task.receive()
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

private struct SessionCreated: Decodable {
    let id: String
    let websocketPath: String
    let ticket: String
}

private struct ErrorBody: Decodable {
    let code: String
    let message: String
    let recoverable: Bool
}

private struct ErrorEnvelope: Decodable {
    let error: ErrorBody
}

private struct EventEnvelope: Decodable {
    let type: String
    let transcript: SedaTranscript?
    let error: ErrorBody?
}

private func protocolError(_ message: String) -> SedaError {
    SedaError(
        code: "runtime_failed",
        message: message,
        recoverable: false,
        status: nil
    )
}

import Foundation
import XCTest
@testable import Seda

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class FakeWebSocket: SedaWebSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [URLSessionWebSocketTask.Message] = [
        .string(#"{"type":"ready","session_id":"session-1"}"#),
        .string(
            #"{"type":"transcript","segment_id":"session-1:0","revision":1,"text":"hallo","stable_text":"","unstable_text":"hallo","final":false,"words":[]}"#
        ),
        .string(
            #"{"type":"completed","transcript":{"text":"hallo welt","words":[],"language":"de-DE","durationMs":900}}"#
        ),
    ]
    private(set) var writes: [URLSessionWebSocketTask.Message] = []
    private(set) var closed = false

    func resume() {}

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        lock.withLock { writes.append(message) }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        lock.withLock { messages.removeFirst() }
    }

    func cancel() {
        lock.withLock { closed = true }
    }
}

final class SedaTests: XCTestCase {
    func testModelIdentityAndStreamLanguageAreIndependent() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let socket = FakeWebSocket()
        nonisolated(unsafe) var requestedLanguage: String?

        MockURLProtocol.handler = { request in
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer token"
            )
            switch request.url!.path {
            case "/v1/capabilities":
                return (
                    200,
                    Data(
                        """
                        {
                          "runtime":"fixture",
                          "resolvedModel":{
                            "id":"fixture/streaming","revision":"test",
                            "variant":"fixture","runtime":"fixture"
                          },
                          "language":{
                            "mode":"prompted","supported":["en-US","de-DE"],
                            "supportsAuto":true
                          },
                          "streaming":"true","punctuation":true,
                          "wordTimestamps":true,"globalPushToTalk":false,
                          "focusedAppInsertion":false
                        }
                        """.utf8
                    )
                )
            case "/v1/sessions":
                let body = try requestBody(request)
                let value = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                requestedLanguage = value["language"] as? String
                return (
                    200,
                    Data(
                        """
                        {
                          "id":"session-1",
                          "websocketPath":"/v1/sessions/session-1/stream",
                          "ticket":"ticket-1"
                        }
                        """.utf8
                    )
                )
            default:
                XCTFail("Unexpected request: \(request.url!.path)")
                return (404, Data())
            }
        }

        let seda = Seda.testing(
            baseURL: URL(string: "http://127.0.0.1:7331/")!,
            token: "token",
            urlSession: session,
            socketFactory: { _ in socket }
        )
        let capabilities = try await seda.capabilities()
        XCTAssertEqual(capabilities.resolvedModel.id, "fixture/streaming")
        XCTAssertEqual(capabilities.language.mode, "prompted")

        let live = try await seda.listen(language: "de-DE")
        try await live.write(Data([0, 0, 1, 0]))
        nonisolated(unsafe) var partial = ""
        let transcript = try await live.commit { update in
            partial = update.text
        }

        XCTAssertEqual(requestedLanguage, "de-DE")
        XCTAssertEqual(partial, "hallo")
        XCTAssertEqual(transcript.text, "hallo welt")
        XCTAssertTrue(socket.closed)
    }

    func testFixtureSidecarIntegration() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard
            let baseURL = environment["SEDA_TEST_BASE_URL"].flatMap(URL.init),
            let token = environment["SEDA_TEST_TOKEN"]
        else {
            return
        }
        let seda = try await Seda.connect(baseURL: baseURL, token: token)
        let capabilities = try await seda.capabilities()
        XCTAssertEqual(capabilities.resolvedModel.id, "fixture/streaming-en")

        let complete = try await seda.transcribe(
            wav: wavFixture(samples: 320),
            language: "en"
        )
        XCTAssertEqual(complete.text, "hello world")

        let live = try await seda.listen(language: "en")
        try await live.write(Data(repeating: 0, count: 320))
        try await live.write(Data(repeating: 0, count: 320))
        nonisolated(unsafe) var updates = 0
        let transcript = try await live.commit { _ in updates += 1 }
        XCTAssertEqual(transcript.text, "hello world")
        XCTAssertGreaterThanOrEqual(updates, 2)
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    let stream = try XCTUnwrap(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count >= 0 else {
            throw stream.streamError ?? URLError(.cannotDecodeContentData)
        }
        if count == 0 {
            break
        }
        data.append(buffer, count: count)
    }
    return data
}

private func wavFixture(samples: UInt32) -> Data {
    var output = Data()
    output.append(contentsOf: "RIFF".utf8)
    output.appendLittleEndian(36 + samples * 2)
    output.append(contentsOf: "WAVEfmt ".utf8)
    output.appendLittleEndian(UInt32(16))
    output.appendLittleEndian(UInt16(1))
    output.appendLittleEndian(UInt16(1))
    output.appendLittleEndian(UInt32(16_000))
    output.appendLittleEndian(UInt32(32_000))
    output.appendLittleEndian(UInt16(2))
    output.appendLittleEndian(UInt16(16))
    output.append(contentsOf: "data".utf8)
    output.appendLittleEndian(samples * 2)
    output.append(Data(repeating: 0, count: Int(samples * 2)))
    return output
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

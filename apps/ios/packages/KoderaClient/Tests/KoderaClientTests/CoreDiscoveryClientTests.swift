import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

@MainActor
final class CoreDiscoveryClientTests: XCTestCase {
    private func client(timeout: TimeInterval = 1) throws -> CoreDiscoveryClient {
        try CoreDiscoveryClient(configuration: DiscoveryFixtures.configuration,
            protocolClass: URLProtocolFixture.self, resourceTimeout: timeout)
    }
    private func installZero() throws {
        URLProtocolFixture.install(.body(status: 200, headers: DiscoveryFixtures.headers,
            chunks: [try DiscoveryFixtures.data("discovery-zero")]))
    }

    func testExactAnonymousSlugRequest() async throws {
        try installZero()
        let client = try client()
        let outcome = await client.discover(slug: "1team")
        XCTAssertEqual(outcome, .result(.noMatch))
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        if let request = URLProtocolFixture.requests.first {
            XCTAssertEqual(request.url?.absoluteString, "https://core.test/api/v1/auth/discover")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertTrue(request.value(forHTTPHeaderField: "Accept")?.contains("application/json") == true)
            XCTAssertTrue(request.value(forHTTPHeaderField: "Accept")?.contains("application/problem+json") == true)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            let key = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertTrue((16...255).contains(key.utf8.count))
            XCTAssertTrue(key.utf8.allSatisfy { $0 > 32 && $0 < 127 })
            let data = try URLProtocolFixture.bodyData(request)
            XCTAssertLessThanOrEqual(data.count, 4096)
            XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String], ["slug": "1team"])
        }
        await client.close()
    }

    func testCanonicalSlugIsPreservedAndInvalidInputDoesNotStartTask() async throws {
        for slug in ["UPPER", " atelier", "atelier\n", "https://core.test", "tiny", String(repeating: "a", count: 21)] {
            try installZero()
            let client = try client()
            let received1 = await client.discover(slug: slug)
            XCTAssertEqual(received1, .failure(.invalidInput), slug)
            XCTAssertTrue(URLProtocolFixture.requests.isEmpty, slug)
            await client.close()
        }
    }

    func testMissingConfigurationStartsNoTask() async {
        URLProtocolFixture.install(.hold)
        let client = CoreDiscoveryClient(configuration: nil)
        let received2 = await client.discover(slug: "atelier")
        XCTAssertEqual(received2, .failure(.notConfigured))
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        await client.close()
    }

    func testUntrustedOriginProfilesAreRefusedBeforeURLConstruction() {
        for origin in ["http://core.test", "https://core.test/", "https://core.test:443", "https://user@core.test",
            "https://core.test/path", "https://core%2etest", "https://core.test\n", "https://0x7f.1"] {
            XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: origin,
                admittedIssuerOrigins: ["https://id.kodera.io"]), origin)
        }
        XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["https://id.kodera.io:443"]))
        XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: []))
    }

    func testLoopbackDiscoveryIsADevelopmentPolicyOnly() throws {
        for (core, issuer) in [("http://localhost:8000", "http://localhost:8080"),
                               ("https://core.test", "http://127.0.0.1:8080")] {
            XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: core, admittedIssuerOrigins: [issuer]),
                core + " " + issuer)
        }
        let development = try CoreDiscoveryConfiguration(coreApiOrigin: "http://localhost:8000",
            admittedIssuerOrigins: ["http://localhost:8080"], loopback: .admitForDevelopment)
        XCTAssertEqual(development.trust.loopback, .admitForDevelopment)
        for (core, issuer) in [("http://localhost:8000/", "http://localhost:8080"),
                               ("http://localhost:8000", "http://localhost.evil.test:8080"),
                               ("http://core.test:8000", "http://localhost:8080")] {
            XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: core, admittedIssuerOrigins: [issuer],
                loopback: .admitForDevelopment), core + " " + issuer)
        }
    }

    func testUnexpectedStatusAndHTMLCannotBecomeNoMatch() async throws {
        // 403 is documented (a browser refused from its headers), so it is no longer "unsupported service".
        for status in [401, 404, 405, 409, 501] {
            URLProtocolFixture.install(.body(status: status, headers: ["Content-Type": "text/html"], chunks: [Data("<html>proxy</html>".utf8)]))
            let client = try client()
            let received3 = await client.discover(slug: "atelier")
            XCTAssertEqual(received3, .failure(.unsupportedService), "status \(status)")
            XCTAssertEqual(URLProtocolFixture.requests.count, 1)
            await client.close()
        }
        for status in [200, 403] {
            URLProtocolFixture.install(.body(status: status, headers: ["Content-Type": "text/html"],
                chunks: [Data("<html>not discovery</html>".utf8)]))
            let client = try client()
            let outcome = await client.discover(slug: "atelier")
            XCTAssertEqual(outcome, .failure(.protocolViolation), "status \(status)")
            await client.close()
        }
    }

    func testEveryRedirectIsRefusedWithoutSecondRequest() async throws {
        #if canImport(Darwin)
        for status in [301, 302, 303, 307, 308] {
            for location in ["https://core.test/other", "https://other.test/other"] {
                URLProtocolFixture.install(.redirect(status: status, location: location))
                let client = try client()
                let received4 = await client.discover(slug: "atelier")
                XCTAssertEqual(received4, .failure(.protocolViolation))
                XCTAssertEqual(URLProtocolFixture.requests.count, 1)
                await client.close()
            }
        }
        #else
        // swift-corelibs-foundation traps on URLProtocol-delivered redirects; the macOS job owns this case.
        throw XCTSkip("URLProtocol redirects are unsupported by swift-corelibs-foundation")
        #endif
    }

    func testDeclaredOversizeCancelsBeforeBody() async throws {
        var headers = DiscoveryFixtures.headers
        headers["Content-Length"] = "65537"
        URLProtocolFixture.install(.stream(status: 200, headers: headers, chunks: []))
        let client = try client()
        let received5 = await client.discover(slug: "atelier")
        XCTAssertEqual(received5, .failure(.protocolViolation))
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        let stopped = await URLProtocolFixture.waitForStop()
        XCTAssertGreaterThan(stopped, 0)
        await client.close()
    }

    func testChunkedBodyCapCancelsActualTask() async throws {
        for status in [200, 500] {
            let headers = status == 200 ? DiscoveryFixtures.headers : DiscoveryFixtures.problemHeaders()
            URLProtocolFixture.install(.stream(status: status, headers: headers,
                chunks: [Data(repeating: 32, count: 32768), Data(repeating: 32, count: 32768), Data([32])]))
            let client = try client()
            let received6 = await client.discover(slug: "atelier")
            XCTAssertEqual(received6, .failure(.protocolViolation))
            XCTAssertEqual(URLProtocolFixture.requests.count, 1)
            let stopped = await URLProtocolFixture.waitForStop()
            XCTAssertGreaterThan(stopped, 0)
            await client.close()
        }
    }

    func testExactBodyCapIsAccepted() async throws {
        var body = try DiscoveryFixtures.data("discovery-zero")
        body.append(Data(repeating: 32, count: 65536 - body.count))
        URLProtocolFixture.install(.body(status: 200, headers: DiscoveryFixtures.headers, chunks: [body]))
        let client = try client()
        let received7 = await client.discover(slug: "atelier")
        XCTAssertEqual(received7, .result(.noMatch))
        await client.close()
    }

    func testTimeoutOfflineTLSAndHTTPAuthStayUnavailable() async throws {
        for (code, expected) in [(URLError.Code.timedOut, TransportFailure.timeout),
            (.notConnectedToInternet, .offline), (.serverCertificateUntrusted, .tls), (.userAuthenticationRequired, .authenticationChallenge)] {
            URLProtocolFixture.install(.failure(code))
            let client = try client()
            let received8 = await client.discover(slug: "atelier")
            XCTAssertEqual(received8, .failure(.transport(expected)))
            await client.close()
        }
    }

    func testResourceTimeoutTerminatesHeldTransport() async throws {
        let probe = HeldTimeoutProbe()
        HeldTimeoutProtocol.install(probe)
        defer { HeldTimeoutProtocol.retire(probe) }
        let client = try CoreDiscoveryClient(configuration: DiscoveryFixtures.configuration,
            protocolClass: HeldTimeoutProtocol.self, resourceTimeout: 1,
            completionGate: { probe.recordDelegateCompletion() })
        let task = Task { await client.discover(slug: "atelier") }
        let clock = ContinuousClock()
        let startDeadline = clock.now.advanced(by: .milliseconds(250))
        while clock.now < startDeadline {
            let current = probe.snapshot()
            if !current.started.isEmpty || current.delegateCompletions > 0 { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        let held = probe.snapshot()
        guard held.started.count == 1, held.stopped.isEmpty, held.delegateCompletions == 0 else {
            task.cancel()
            _ = await task.value
            await client.close()
            return XCTFail("Actual started-held timeout setup was not established: \(held)")
        }
        let received9 = await task.value
        let atOutcome = probe.snapshot()
        let stopDeadline = clock.now.advanced(by: .milliseconds(500))
        while clock.now < stopDeadline {
            if probe.snapshot().acknowledges(held.started) { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        let terminal = probe.snapshot()
        await client.close()
        XCTAssertEqual(received9, .failure(.transport(.timeout)))
        XCTAssertEqual(atOutcome.delegateCompletions, 1, "Actual delegate completion required: \(atOutcome)")
        XCTAssertEqual(terminal.started, held.started, "No replacement fixture instance may satisfy timeout: \(terminal)")
        XCTAssertTrue(terminal.acknowledges(held.started),
            "Actual same-instance stop acknowledgement required; outcome trace: \(atOutcome); terminal trace: \(terminal)")
    }

    func testCancellationClosesActualTaskAndClosedClientRefuses() async throws {
        URLProtocolFixture.install(.hold)
        let client = try client()
        let task = Task { await client.discover(slug: "atelier") }
        await URLProtocolFixture.waitForStart()
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        task.cancel()
        let received10 = await task.value
        XCTAssertEqual(received10, .cancelled)
        let stopped = await URLProtocolFixture.waitForStop()
        XCTAssertGreaterThan(stopped, 0)
        await client.close()
        let received11 = await client.discover(slug: "atelier")
        XCTAssertEqual(received11, .failure(.notConfigured))
    }

    func testRepeatedManualLookupsUseFreshKeysAndNoReplayCache() async throws {
        try installZero()
        let client = try client()
        _ = await client.discover(slug: "atelier")
        _ = await client.discover(slug: "atelier")
        let requests = URLProtocolFixture.requests
        XCTAssertEqual(requests.count, 2)
        if requests.count == 2 {
            XCTAssertNotEqual(requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
                requests[1].value(forHTTPHeaderField: "Idempotency-Key"))
        }
        await client.close()
    }
}

// Timeout-only probe: callbacks retain the run captured when their protocol instance was made.
private final class HeldTimeoutProbe: @unchecked Sendable {
    struct Snapshot: Sendable {
        let runID: UUID
        let started: [UUID]
        let stopped: [UUID]
        let delegateCompletions: Int

        func acknowledges(_ expected: [UUID]) -> Bool {
            expected.count == 1 && started == expected && !stopped.isEmpty && Set(stopped) == Set(expected)
        }
    }
    private let lock = NSLock()
    private let runID = UUID()
    private var started: [UUID] = []
    private var stopped: [UUID] = []
    private var delegateCompletions = 0

    func recordStart(_ instance: UUID) { lock.withLock { started.append(instance) } }
    func recordStop(_ instance: UUID) { lock.withLock { stopped.append(instance) } }
    func recordDelegateCompletion() { lock.withLock { delegateCompletions += 1 } }
    func snapshot() -> Snapshot {
        lock.withLock {
            Snapshot(runID: runID, started: started, stopped: stopped, delegateCompletions: delegateCompletions)
        }
    }
}

private final class HeldTimeoutProtocol: URLProtocol, @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        let lock = NSLock()
        var current: HeldTimeoutProbe?
    }
    private static let registry = Registry()
    private let probe = HeldTimeoutProtocol.captureProbe()
    private let instanceID = UUID()

    static func install(_ probe: HeldTimeoutProbe) {
        registry.lock.withLock { registry.current = probe }
    }
    static func retire(_ probe: HeldTimeoutProbe) {
        registry.lock.withLock { if registry.current === probe { registry.current = nil } }
    }
    private static func captureProbe() -> HeldTimeoutProbe? {
        registry.lock.withLock { registry.current }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { probe?.recordStart(instanceID) }
    override func stopLoading() { probe?.recordStop(instanceID) }
}

import Dispatch
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import KoderaClient

/// Test-only held transports: the first cancellation acknowledgement is explicitly gated.
private final class DelayedCancellationProtocol: URLProtocol, @unchecked Sendable {
    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var started: Set<ObjectIdentifier> = []
        var stopped: Set<ObjectIdentifier> = []
        var firstCompletion = true
        var completionEntries = 0
        var acknowledgement = DispatchSemaphore(value: 0)
    }
    private static let storage = Storage()
    static func reset() {
        storage.lock.withLock {
            storage.started = []
            storage.stopped = []
            storage.firstCompletion = true
            storage.completionEntries = 0
            storage.acknowledgement = DispatchSemaphore(value: 0)
        }
    }
    static var startCount: Int { storage.lock.withLock { storage.started.count } }
    static var stopCount: Int { storage.lock.withLock { storage.stopped.count } }
    static var completionGateEntries: Int { storage.lock.withLock { storage.completionEntries } }
    static func acknowledgeFirstCompletion() {
        let gate = storage.lock.withLock { storage.acknowledgement }
        gate.signal()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        _ = Self.storage.lock.withLock { Self.storage.started.insert(ObjectIdentifier(self)) }
    }
    override func stopLoading() {
        _ = Self.storage.lock.withLock { Self.storage.stopped.insert(ObjectIdentifier(self)) }
    }
    static func holdFirstCompletion() {
        let gate = Self.storage.lock.withLock { () -> DispatchSemaphore? in
            guard Self.storage.firstCompletion else { return nil }
            Self.storage.firstCompletion = false
            Self.storage.completionEntries += 1
            return Self.storage.acknowledgement
        }
        // Only this URLSession's private completion queue is held; protocol delivery never blocks.
        _ = gate?.wait(timeout: .now() + 2)
    }
}

@MainActor
final class ClientRegressionTests: XCTestCase {
    private func reaches(_ expected: Int, read: () -> Int) async -> Bool {
        for _ in 0..<80 {
            if read() >= expected { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return read() >= expected
    }

    func testCloseCancelsAllActiveRequestsBeforeAwaitingFirstAcknowledgement() async throws {
        DelayedCancellationProtocol.reset()
        let client = try CoreDiscoveryClient(configuration: DiscoveryFixtures.configuration,
            protocolClass: DelayedCancellationProtocol.self, resourceTimeout: 5,
            completionGate: { DelayedCancellationProtocol.holdFirstCompletion() })
        let first = Task { await client.discover(slug: "alpha") }
        let second = Task { await client.discover(slug: "bravo") }
        let started = await reaches(2) { DelayedCancellationProtocol.startCount }
        XCTAssertTrue(started, "Both real URLSession fixture tasks must start before close")
        let closing = Task { await client.close() }
        let completionHeld = await reaches(1) { DelayedCancellationProtocol.completionGateEntries }
        XCTAssertTrue(completionHeld, "An actual private task-completion callback must enter the acknowledgement gate")
        let allCancelled = await reaches(2) { DelayedCancellationProtocol.stopCount }
        XCTAssertTrue(allCancelled, "Close must signal every active transport while the first acknowledgement is withheld")
        DelayedCancellationProtocol.acknowledgeFirstCompletion()
        await closing.value
        let firstOutcome = await first.value
        let secondOutcome = await second.value
        XCTAssertEqual(firstOutcome, .cancelled)
        XCTAssertEqual(secondOutcome, .cancelled)
    }

    func testSingleResultMustMatchQueryWhileMultipleRemainsExplicitChoice() async throws {
        URLProtocolFixture.install(.body(status: 200, headers: DiscoveryFixtures.headers,
            chunks: [try DiscoveryFixtures.data("discovery-one")]))
        let client = try CoreDiscoveryClient(configuration: DiscoveryFixtures.configuration,
            protocolClass: URLProtocolFixture.self, resourceTimeout: 1)
        let mismatch = await client.discover(slug: "bureau")
        XCTAssertEqual(mismatch, .failure(.protocolViolation), "An internally valid Atelier single result cannot answer a Bureau lookup")
        URLProtocolFixture.install(.body(status: 200, headers: DiscoveryFixtures.headers,
            chunks: [try DiscoveryFixtures.data("discovery-many")]))
        let multiple = await client.discover(slug: "atelier")
        guard case let .result(.multiple(choices)) = multiple else {
            await client.close()
            return XCTFail("The declared many-candidate envelope must retain explicit-choice handling")
        }
        XCTAssertEqual(choices.map(\.organisationSlug), ["atelier", "bureau"])
        await client.close()
    }
}

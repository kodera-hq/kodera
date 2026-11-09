import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

/// Records what a Core client asked of the sign-in owner.
actor FakeTokens: AccessTokenProvider {
    private var issued = 0
    /// Every call for a token, served or not.
    private(set) var requested = 0
    private(set) var forcedRefreshes = 0
    /// Explicit sign-outs: the only call that revokes.
    private(set) var signOuts = 0
    /// Sessions ended on this device only, without revoking.
    private(set) var localEnds = 0
    /// The session each local end named.
    private(set) var endedSessions: [UInt64] = []
    private let refusesRefresh: Bool
    private let unavailable: Bool
    private let keepsStoredCopy: Bool

    init(refusesRefresh: Bool = false, unavailable: Bool = false, keepsStoredCopy: Bool = false) {
        self.refusesRefresh = refusesRefresh
        self.unavailable = unavailable
        self.keepsStoredCopy = keepsStoredCopy
    }

    /// Each token is served by its own session number, so a test can tell which one a local end named.
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        requested += 1
        if unavailable { throw .unavailable }
        if forceRefresh {
            forcedRefreshes += 1
            if refusesRefresh {
                localEnds += 1 // the owner wipes its own state when a refresh is refused
                throw keepsStoredCopy ? .signedOutNotWiped : .signedOut
            }
        }
        issued += 1
        return AccessToken(value: "synthetic-access-\(issued)", session: UInt64(100 + issued))
    }

    func signOut() async throws(SessionNotWiped) {
        signOuts += 1
        if keepsStoredCopy { throw SessionNotWiped() }
    }

    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {
        localEnds += 1
        endedSessions.append(session)
        if keepsStoredCopy { throw SessionNotWiped() }
    }
}

private final class W04Signal: @unchecked Sendable {
    let expectation: XCTestExpectation
    private let lock = NSLock()
    private var done = false
    init(_ name: String) { expectation = XCTestExpectation(description: name) }
    var finished: Bool { lock.withLock { done } }
    func finish() {
        let first = lock.withLock { if done { return false }; done = true; return true }
        if first { expectation.fulfill() }
    }
}

private final class W04Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var pending: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            let immediate = lock.withLock {
                if open { return true }
                pending = continuation; return false
            }
            if immediate { continuation.resume() }
        }
    }
    func release() {
        let continuation = lock.withLock { open = true; let old = pending; pending = nil; return old }
        continuation?.resume()
    }
}

private final class W04Trace: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String] = []
    var events: [String] { lock.withLock { records } }
    func add(_ value: String) { lock.withLock { records.append(value) } }
}

private final class W04Recorder: @unchecked Sendable {
    private struct Watch { let phase: CoreBodyObservation.Phase; let retained: Int?; let signal: W04Signal }
    private var watches: [Watch] = []
    func acknowledgement(_ phase: CoreBodyObservation.Phase, retained: Int? = nil) -> W04Signal {
        let signal = W04Signal("actual transport processing acknowledgement")
        let present = lock.withLock {
            watches.append(Watch(phase: phase, retained: retained, signal: signal))
            return records.contains { $0.phase == phase && (retained == nil || $0.retained == retained) }
        }
        if present { signal.finish() }
        return signal
    }
    let trace: W04Trace
    let terminal = W04Signal("real terminal selected")
    let drained = W04Signal("URLSession invalidation delegate completed")
    private let lock = NSLock()
    private var records: [CoreBodyObservation] = []
    init(trace: W04Trace) { self.trace = trace }
    var events: [CoreBodyObservation] { lock.withLock { records.sorted { $0.sequence < $1.sequence } } }
    func record(_ event: CoreBodyObservation) {
        let signals = lock.withLock {
            records.append(event)
            return watches.filter { $0.phase == event.phase && ($0.retained == nil || $0.retained == event.retained) }.map(\.signal)
        }
        for signal in signals { signal.finish() }
        trace.add("transport.\(event.phase)")
        if event.phase == .terminal { terminal.finish() }
        if event.phase == .sessionDrained { drained.finish() }
    }
}

/// Owns one finite worker and its Foundation endpoint. Foundation objects never escape this capsule.
private final class W04Load: @unchecked Sendable {
    private struct Endpoint {
        let protocolInstance: URLProtocol
        let client: any URLProtocolClient
    }
    private enum Delivery {
        case response(HTTPURLResponse)
        case data(Data)
        case eof
        case failure(URLError.Code)
    }
    let prefix = W04Gate(), step = W04Gate(), tail = W04Gate()
    let prefixSent = W04Signal("fixture finite prefix offered")
    let registered = W04Signal("fixture worker registered")
    let stopped = W04Signal("actual URLProtocol stopLoading")
    private let lock = NSLock()
    private var closed = false
    private var callbacks = 0
    private var worker: Task<Void, Never>?
    private var endpoint: Endpoint?

    /// Bound once before the scenario publishes this load or a worker can start.
    init(protocolInstance: URLProtocol, client: any URLProtocolClient) {
        endpoint = Endpoint(protocolInstance: protocolInstance, client: client)
    }
    func attach(_ task: Task<Void, Never>) { lock.withLock { worker = task }; registered.finish() }
    var task: Task<Void, Never>? { lock.withLock { worker } }

    /// The one worker invokes these typed operations; stop only closes new reservations.
    private func deliver(_ delivery: Delivery, scenario: W04Scenario) -> Bool {
        let target = lock.withLock { () -> Endpoint? in
            guard !closed, let endpoint else { return nil }
            callbacks += 1
            return endpoint
        }
        guard let target else { return false }
        defer { lock.withLock { callbacks -= 1 } }
        switch delivery {
        case let .response(response):
            target.client.urlProtocol(target.protocolInstance, didReceive: response, cacheStoragePolicy: .notAllowed)
        case let .data(data):
            scenario.offered(data.count)
            target.client.urlProtocol(target.protocolInstance, didLoad: data)
        case .eof:
            scenario.trace.add("fixture.eofSubmitted")
            target.client.urlProtocolDidFinishLoading(target.protocolInstance)
        case let .failure(code):
            target.client.urlProtocol(target.protocolInstance, didFailWithError: URLError(code))
        }
        return true
    }
    func receive(_ response: HTTPURLResponse, scenario: W04Scenario) -> Bool { deliver(.response(response), scenario: scenario) }
    func send(_ data: Data, scenario: W04Scenario) -> Bool { deliver(.data(data), scenario: scenario) }
    func finish(scenario: W04Scenario) -> Bool { deliver(.eof, scenario: scenario) }
    func fail(_ code: URLError.Code, scenario: W04Scenario) -> Bool { deliver(.failure(code), scenario: scenario) }

    func close(actualStop: Bool) {
        lock.withLock { closed = true }
        if actualStop { stopped.finish() }
        else { prefix.release(); step.release(); tail.release() }
    }
    /// Called only after registration and the whole registered worker have been awaited.
    func clearAfterJoin() throws {
        let extracted = try lock.withLock { () throws -> (Task<Void, Never>?, Endpoint?) in
            guard closed, callbacks == 0 else { throw W04SetupFailure() }
            let references = (worker, endpoint)
            worker = nil; endpoint = nil
            return references
        }
        // Final framework releases can reenter Foundation, so keep them outside the state lock.
        withExtendedLifetime(extracted) {}
    }
}

private final class W04Scenario: @unchecked Sendable {
    let prefixSizes: [Int]
    let stepSize: Int
    let tailSize: Int
    let declaredLength: String?
    init(prefixSizes: [Int] = [65_537], stepSize: Int = 0, tailSize: Int = 1, declaredLength: String? = nil) {
        self.prefixSizes = prefixSizes; self.stepSize = stepSize; self.tailSize = tailSize; self.declaredLength = declaredLength
    }
    let trace = W04Trace()
    let started = W04Signal("actual synthetic HTTP request")
    private let lock = NSLock()
    private var closed = false
    private var loads: [W04Load] = []
    private var invalid = 0
    private var offered = 0
    var all: [W04Load] { lock.withLock { loads } }
    var invalidCount: Int { lock.withLock { invalid } }
    var offeredCount: Int { lock.withLock { offered } }
    func register(valid: Bool, protocolInstance: URLProtocol, client: any URLProtocolClient) -> W04Load? {
        lock.withLock {
            if !valid { invalid += 1 }
            guard !closed && valid else { return nil }
            let load = W04Load(protocolInstance: protocolInstance, client: client); loads.append(load); return load
        }
    }
    func offered(_ count: Int) { lock.withLock { offered += count } }
    func close() -> [W04Load] {
        let snapshot = lock.withLock { closed = true; return loads }
        for load in snapshot { load.close(actualStop: false) }
        return snapshot
    }
}

private final class W04Protocol: URLProtocol {
    private final class Registry: @unchecked Sendable { let lock = NSLock(); var scenario: W04Scenario? }
    private static let registry = Registry()
    private let lock = NSLock()
    private var closed = false
    private var load: W04Load?
    static func install(_ scenario: W04Scenario?) { registry.lock.withLock { registry.scenario = scenario } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let scenario = Self.registry.lock.withLock { Self.registry.scenario }
        let valid = request.url?.absoluteString == "https://core.test/api/v1/resource" && request.httpMethod == "GET" &&
            request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-access-1"
        guard let url = request.url, let client else {
            XCTFail("W04 fixture endpoint is unavailable")
            self.client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        guard let scenario, let load = scenario.register(valid: valid, protocolInstance: self, client: client) else {
            client.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let alreadyStopped = lock.withLock { self.load = load; return closed }
        if alreadyStopped { load.close(actualStop: true) }
        let worker = Task { [scenario, load, url] in
            var headers = ["Content-Type": "application/json"]
            if let length = scenario.declaredLength { headers["Content-Length"] = length }
            if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                              headerFields: headers) {
                _ = load.receive(response, scenario: scenario)
                await load.prefix.wait()
                for size in scenario.prefixSizes {
                    let prefix = Data(repeating: 32, count: size)
                    if load.send(prefix, scenario: scenario) {
                        scenario.trace.add("fixture.prefixOffered")
                    }
                }
                load.prefixSent.finish()
                if scenario.stepSize > 0 {
                    await load.step.wait()
                    _ = load.send(Data(repeating: 32, count: scenario.stepSize), scenario: scenario)
                }
                await load.tail.wait()
                if scenario.tailSize > 0 {
                    _ = load.send(Data(repeating: 32, count: scenario.tailSize), scenario: scenario)
                }
                _ = load.finish(scenario: scenario)
            } else {
                _ = load.fail(.badURL, scenario: scenario)
            }
        }
        load.attach(worker)
        scenario.started.finish()
    }
    override func stopLoading() {
        let load = lock.withLock { closed = true; return self.load }
        load?.close(actualStop: true)
    }
}

private struct W04SetupFailure: Error {}
@MainActor
private final class W04Reply { var value: CoreReply? }

extension CoreRequesterTests {
    private func w04Wait(_ signal: W04Signal) async throws {
        if signal.finished { return }
        let result = await XCTWaiter.fulfillment(of: [signal.expectation], timeout: 5)
        guard result == .completed else { XCTFail("W04 positive acknowledgement or drain missing"); throw W04SetupFailure() }
    }
    private func w04Processed(_ task: Task<Void, Never>) async throws {
        let done = W04Signal("whole worker complete")
        let watcher = Task { await task.value; done.finish() }
        defer { watcher.cancel() }
        try await w04Wait(done)
    }

    func testTransportNeverRetainsBodyBeyondExistingLimit() async throws {
        try await w04Finite(declaredLength: nil)
        try await w04Finite(declaredLength: "1")
    }

    private func w04Finite(declaredLength: String?) async throws {
        let scenario = W04Scenario(declaredLength: declaredLength), box = W04Reply()
        let recorder = W04Recorder(trace: scenario.trace)
        let tokens = FakeTokens()
        let requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: W04Protocol.self, timeout: 15, observeBody: { recorder.record($0) })
        W04Protocol.install(scenario)
        let complete = W04Signal("actual requester task completed")
        let task = Task { box.value = await requester.get(path: "/api/v1/resource"); complete.finish() }
        func finish() async throws {
            let loads = scenario.close()
            task.cancel()
            var firstError: (any Error)?
            do { try await w04Processed(task) } catch { firstError = error }
            if scenario.started.finished {
                do { try await w04Wait(recorder.drained) } catch { if firstError == nil { firstError = error } }
            }
            for load in loads {
                do {
                    try await w04Wait(load.registered)
                    let worker = try XCTUnwrap(load.task, "W04 registered worker handle is missing")
                    try await w04Processed(worker)
                    try load.clearAfterJoin()
                } catch { if firstError == nil { firstError = error } }
            }
            W04Protocol.install(nil)
            XCTAssertEqual(scenario.invalidCount, 0)
            if let firstError { throw firstError }
        }
        do {
            try await w04Wait(scenario.started)
            let load = try XCTUnwrap(scenario.all.first)
            load.prefix.release()
            try await w04Wait(load.prefixSent)
            load.tail.release() // Positive finite release, never a negative timeout/checkpoint.
            try await w04Wait(complete)
            try await w04Processed(task)
            try await w04Wait(recorder.terminal)
            try await w04Wait(recorder.drained)
            try await w04Wait(load.registered)
            if let worker = load.task { try await w04Processed(worker) }
            let events = recorder.events
            let legacy = events.filter { $0.phase == .completeBody }
            let retained = events.filter { $0.phase == .completeBody || $0.phase == .retained || $0.phase == .overflow }
            XCTAssertFalse(retained.isEmpty, "MissingActualBodyMeasurement")
            let peak = try XCTUnwrap(retained.map(\.retained).max())
            XCTAssertEqual(Set(events.map(\.attempt)).count, 1)
            XCTAssertEqual(events.filter { $0.phase == .terminal }.count, 1)
            XCTAssertEqual(scenario.invalidCount, 0)
            if peak > StrictJSON.byteLimit && !legacy.isEmpty {
                XCTAssertEqual(legacy.map(\.retained), [65_538])
                XCTAssertEqual(scenario.offeredCount, 65_538)
                let trace = scenario.trace.events
                let eof = try XCTUnwrap(trace.firstIndex(of: "fixture.eofSubmitted"))
                let buffered = try XCTUnwrap(trace.firstIndex(of: "transport.completeBody"))
                XCTAssertLessThan(eof, buffered)
                XCTAssertEqual(box.value, .tooLarge)
            }
            let requests = await tokens.requested, refreshes = await tokens.forcedRefreshes, ends = await tokens.localEnds
            XCTAssertEqual(requests, 1); XCTAssertEqual(refreshes, 0); XCTAssertEqual(ends, 0)
            print("W04 finiteBody peak=\(peak) offered=\(scenario.offeredCount) legacy=\(!legacy.isEmpty) terminals=\(events.filter { $0.phase == .terminal }.count) sessionDrained=\(recorder.drained.finished)")
            XCTAssertLessThanOrEqual(peak, StrictJSON.byteLimit, "BodyAccumulatedPastExistingLimit")
            XCTAssertEqual(box.value, .tooLarge)
        } catch {
            try await finish()
            throw error
        }
        try await finish()
    }
    private func w04Complete(_ complete: W04Signal, _ task: Task<Void, Never>, _ recorder: W04Recorder) async throws {
        try await w04Wait(complete)
        try await w04Processed(task)
        try await w04Wait(recorder.terminal)
        try await w04Wait(recorder.drained)
    }

    private func w04AssertBound(_ recorder: W04Recorder) throws {
        let measurements = recorder.events.filter { $0.phase == .retained || $0.phase == .overflow || $0.phase == .completeBody }
        XCTAssertFalse(measurements.isEmpty, "MissingActualBodyMeasurement")
        let peak = try XCTUnwrap(measurements.map(\.retained).max())
        print("W04 resource peak=\(peak) measurements=\(measurements.count)")
        XCTAssertLessThanOrEqual(peak, StrictJSON.byteLimit, "BodyAccumulatedPastExistingLimit")
    }

    private func w04Scenario(_ scenario: W04Scenario,
        run: @MainActor (W04Recorder, W04Load, Task<Void, Never>, W04Reply, W04Signal) async throws -> Void) async throws {
        let box = W04Reply(), recorder = W04Recorder(trace: scenario.trace), tokens = FakeTokens()
        let requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: W04Protocol.self, timeout: 15, observeBody: { recorder.record($0) })
        W04Protocol.install(scenario)
        let complete = W04Signal("actual requester task completed")
        let task = Task { box.value = await requester.get(path: "/api/v1/resource"); complete.finish() }
        func finish() async throws {
            let loads = scenario.close()
            task.cancel()
            var firstError: (any Error)?
            do { try await w04Processed(task) } catch { firstError = error }
            if scenario.started.finished {
                do { try await w04Wait(recorder.drained) } catch { if firstError == nil { firstError = error } }
            }
            for load in loads {
                do {
                    try await w04Wait(load.registered)
                    let worker = try XCTUnwrap(load.task, "W04 registered worker handle is missing")
                    try await w04Processed(worker)
                    try load.clearAfterJoin()
                } catch { if firstError == nil { firstError = error } }
            }
            W04Protocol.install(nil)
            XCTAssertEqual(scenario.invalidCount, 0)
            if let firstError { throw firstError }
        }
        do {
            try await w04Wait(scenario.started)
            let load = try XCTUnwrap(scenario.all.first)
            try await run(recorder, load, task, box, complete)
            XCTAssertEqual(recorder.events.filter { $0.phase == .terminal }.count, 1)
            XCTAssertEqual(Set(recorder.events.map(\.attempt)).count, 1)
            let requests = await tokens.requested, refreshes = await tokens.forcedRefreshes, ends = await tokens.localEnds
            XCTAssertEqual(requests, 1); XCTAssertEqual(refreshes, 0); XCTAssertEqual(ends, 0)
            let ledger = recorder.events.map { "\($0.sequence):\($0.phase):\($0.retained):\($0.incoming)" }.joined(separator: ",")
            print("W04 ledger [\(ledger)] offered=\(scenario.offeredCount) stop=\(load.stopped.finished) trace=\(scenario.trace.events)")
        } catch {
            try await finish()
            throw error
        }
        try await finish()
    }

    func testOverflowStopsBeforeHeldTailAndEOF() async throws {
        let scenario = W04Scenario(prefixSizes: [65_536], stepSize: 1, tailSize: 17)
        try await w04Scenario(scenario) { recorder, load, task, box, complete in
            try await w04Wait(recorder.acknowledgement(.headerAccepted))
            load.prefix.release()
            try await w04Wait(recorder.acknowledgement(.retained, retained: 65_536))
            load.step.release()
            try await w04Wait(recorder.acknowledgement(.overflow, retained: 65_536))
            try await w04Complete(complete, task, recorder)
            try await w04Wait(load.stopped)
            XCTAssertEqual(box.value, .tooLarge)
            let overflow = try XCTUnwrap(recorder.events.first { $0.phase == .overflow })
            XCTAssertEqual(overflow.incoming, 1)
            XCTAssertEqual(scenario.offeredCount, 65_537)
            XCTAssertFalse(scenario.trace.events.contains("fixture.eofSubmitted"))
            try w04AssertBound(recorder)
        }
    }

    func testDeclaredOversizeStopsBeforeBodyAdmission() async throws {
        let scenario = W04Scenario(declaredLength: "65537")
        try await w04Scenario(scenario) { recorder, load, task, box, complete in
            try await w04Wait(recorder.acknowledgement(.headerRejected, retained: 0))
            try await w04Complete(complete, task, recorder)
            try await w04Wait(load.stopped)
            XCTAssertEqual(box.value, .tooLarge)
            XCTAssertEqual(scenario.offeredCount, 0)
            XCTAssertFalse(recorder.events.contains { $0.phase == .retained || $0.phase == .headerAccepted })
            XCTAssertFalse(scenario.trace.events.contains("fixture.eofSubmitted"))
        }
    }

    func testExactlyBoundedBodyAndSmallBodyCompleteAfterEOF() async throws {
        for sizes in [[4], [65_536], [16_384, 16_384, 16_384, 16_384], [3, 65_530, 3]] {
            let count = sizes.reduce(0, +)
            let scenario = W04Scenario(prefixSizes: sizes, tailSize: 0)
            try await w04Scenario(scenario) { recorder, load, task, box, complete in
                try await w04Wait(recorder.acknowledgement(.headerAccepted))
                load.prefix.release()
                try await w04Wait(recorder.acknowledgement(.retained, retained: count))
                XCTAssertFalse(scenario.trace.events.contains("fixture.eofSubmitted"))
                load.tail.release()
                try await w04Complete(complete, task, recorder)
                XCTAssertEqual(box.value, .answered(status: 200, body: Data(repeating: 32, count: count)))
                XCTAssertFalse(recorder.events.contains { $0.phase == .overflow })
                try w04AssertBound(recorder)
            }
        }
    }

    func testOneOverBoundCannotBeRetainedEvenAtEOF() async throws {
        let scenario = W04Scenario(prefixSizes: [65_537], tailSize: 0)
        try await w04Scenario(scenario) { recorder, load, task, box, complete in
            load.prefix.release()
            try await w04Wait(load.prefixSent)
            load.tail.release()
            try await w04Complete(complete, task, recorder)
            try w04AssertBound(recorder)
            XCTAssertEqual(box.value, .tooLarge)
        }
    }

    func testCallerCancellationDrainsAtResponseAndBodyBoundaries() async throws {
        for afterBody in [false, true] {
            let scenario = W04Scenario(prefixSizes: [1], tailSize: 0)
            try await w04Scenario(scenario) { recorder, load, task, box, complete in
                try await w04Wait(recorder.acknowledgement(.headerAccepted))
                if afterBody {
                    load.prefix.release()
                    try await w04Wait(recorder.acknowledgement(.retained, retained: 1))
                }
                task.cancel()
                try await w04Complete(complete, task, recorder)
                try await w04Wait(load.stopped)
                XCTAssertEqual(box.value, .transport(.other))
                XCTAssertEqual(scenario.offeredCount, afterBody ? 1 : 0)
                XCTAssertFalse(scenario.trace.events.contains("fixture.eofSubmitted"))
            }
        }
    }

    func testSelectedOverflowIsNotReplacedByLateCancellation() async throws {
        let scenario = W04Scenario(prefixSizes: [65_536], stepSize: 1, tailSize: 17)
        try await w04Scenario(scenario) { recorder, load, task, box, complete in
            try await w04Wait(recorder.acknowledgement(.headerAccepted))
            load.prefix.release()
            try await w04Wait(recorder.acknowledgement(.retained, retained: 65_536))
            load.step.release()
            try await w04Wait(recorder.acknowledgement(.overflow, retained: 65_536))
            task.cancel()
            try await w04Complete(complete, task, recorder)
            try await w04Wait(load.stopped)
            XCTAssertEqual(box.value, .tooLarge)
            XCTAssertFalse(scenario.trace.events.contains("fixture.eofSubmitted"))
            try w04AssertBound(recorder)
        }
    }

}

/// The shared Core request path: bound to one origin, bearer, one refresh and one retry on 401, a local end
/// of only the session that served the refused token, 403 without retry, and no redirect. Each caller maps
/// the body itself.
@MainActor
final class CoreRequesterTests: XCTestCase {
    private static let path = "/api/v1/resource"
    private static let url = URL(string: "https://core.test/api/v1/resource")!
    private static let headers = ["Content-Type": "application/json", "Cache-Control": "no-store"]
    private static let body = Data(#"{"synthetic":true}"#.utf8)
    private var ok: URLProtocolFixture.Response { .body(status: 200, headers: Self.headers, chunks: [Self.body]) }
    private let unauthorized = URLProtocolFixture.Response.body(status: 401,
        headers: ["Content-Type": "application/problem+json"], chunks: [Data("{}".utf8)])

    private func requester(_ tokens: FakeTokens, timeout: TimeInterval = 2) throws -> CoreRequester {
        try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: URLProtocolFixture.self, timeout: timeout)
    }

    func testOriginIsValidatedOnceWhenTheRequesterIsBuilt() {
        for origin in ["http://core.test", "https://core.test/", "https://core.test/api", "https://user@core.test",
                       "http://localhost:8000", ""] {
            XCTAssertThrowsError(try CoreRequester(coreApiOrigin: origin, loopback: .refuse, tokens: FakeTokens()),
                                 origin)
        }
        XCTAssertNoThrow(try CoreRequester(coreApiOrigin: "http://localhost:8000", loopback: .admitForDevelopment,
                                           tokens: FakeTokens()))
    }

    /// Paths on the origin go out as the origin followed by the path, unchanged.
    func testAPathOnTheOriginIsSentThere() async throws {
        let paths = ["/api/v1/me", "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/channels",
                     "/a-b_c~d.e/...", "/v1.2"]
        for path in paths {
            URLProtocolFixture.install(ok)
            let reply = try await requester(FakeTokens()).get(path: path)
            XCTAssertEqual(reply, .answered(status: 200, body: Self.body), path)
            XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.absoluteString }, ["https://core.test" + path],
                           path)
        }
    }

    /// Each refused path asks for no token and sends nothing.
    private func assertRefusedBeforeAnyToken(_ paths: [String], _ guardName: String) async throws {
        for path in paths {
            URLProtocolFixture.install(ok)
            let tokens = FakeTokens()
            let reply = try await requester(tokens).get(path: path)
            XCTAssertEqual(reply, .pathRefused, "\(guardName) admitted \(path)")
            let requested = await tokens.requested
            XCTAssertEqual(requested, 0, "a token was asked for before \(path) was refused")
            XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.absoluteString }, [],
                           "\(path) reached the transport")
        }
    }

    /// Owned by the leading-slash rule: without it, the first two would extend the origin's host. The
    /// absolute URL is also refused by the character rule, for its `:`.
    func testAPathWithoutItsLeadingSlashIsRefused() async throws {
        try await assertRefusedBeforeAnyToken([".evil.test/api/v1/me", "api/v1/me", "", "https://evil.test/api/v1/me"],
                                              "the leading-slash rule")
    }

    /// Owned by the empty-segment rule: a scheme-relative `//host`, and any empty segment.
    func testAnEmptySegmentIsRefused() async throws {
        try await assertRefusedBeforeAnyToken(["//evil.test/api/v1/me", "/api//me", "/api/v1/me/", "/"],
                                              "the empty-segment rule")
    }

    /// Owned by the dot-segment rule.
    func testADotSegmentIsRefused() async throws {
        try await assertRefusedBeforeAnyToken(["/api/v1/../../evil", "/..", "/api/./me", "/."],
                                              "the dot-segment rule")
    }

    /// Owned by the character rule: user info, backslash, every percent-encoded variant, port or scheme
    /// separators, query, fragment, whitespace and non-ASCII.
    func testACharacterOutsideTheUnreservedSetIsRefused() async throws {
        try await assertRefusedBeforeAnyToken([
            "/api/v1/me@evil.test", "/@evil.test", "/api\\evil.test", "/%2e%2e/evil", "/api%2fv1", "/%40evil.test",
            "/%5cevil.test", "/x:443", "/api/v1/me?next=https", "/api/v1/me#x", "/api/v1 /me", "/api/v1/m\u{00E9}",
            "/api/v1/me\n",
        ], "the character rule")
    }

    func testSendsTheBearerTokenAndHandsTheAnswerBack() async throws {
        URLProtocolFixture.install(ok)
        let tokens = FakeTokens()
        let reply = try await requester(tokens).get(path: Self.path)
        XCTAssertEqual(reply, .answered(status: 200, body: Self.body))
        let request = try XCTUnwrap(URLProtocolFixture.requests.first)
        XCTAssertEqual(request.url, Self.url)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-access-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json, application/problem+json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store", "the request may be cached")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let forced = await tokens.forcedRefreshes
        XCTAssertEqual(forced, 0)
    }

    func testUnauthorizedRefreshesOnceThenRetries() async throws {
        URLProtocolFixture.install(sequence: [unauthorized, ok])
        let tokens = FakeTokens()
        let reply = try await requester(tokens).get(path: Self.path)
        XCTAssertEqual(reply, .answered(status: 200, body: Self.body), "the retry's answer is not the one returned")
        let forced = await tokens.forcedRefreshes
        let signOuts = await tokens.signOuts
        let localEnds = await tokens.localEnds
        XCTAssertEqual(forced, 1)
        XCTAssertEqual(signOuts, 0)
        XCTAssertEqual(localEnds, 0)
        XCTAssertEqual(URLProtocolFixture.requests.map { $0.value(forHTTPHeaderField: "Authorization") },
                       ["Bearer synthetic-access-1", "Bearer synthetic-access-2"])
    }

    /// The second 401 ends the session on this device only: revoking would end the member's sessions on
    /// their other devices too. It names the session that served the refreshed token, never the first one.
    func testUnauthorizedAfterRefreshEndsOnlyTheSessionThatServedTheToken() async throws {
        URLProtocolFixture.install(sequence: [unauthorized, unauthorized])
        let tokens = FakeTokens()
        let reply = try await requester(tokens).get(path: Self.path)
        XCTAssertEqual(reply, .signedOut)
        let forced = await tokens.forcedRefreshes
        let signOuts = await tokens.signOuts
        let localEnds = await tokens.localEnds
        XCTAssertEqual(forced, 1, "exactly one refresh")
        XCTAssertEqual(signOuts, 0, "a second 401 revoked")
        XCTAssertEqual(localEnds, 1)
        let ended = await tokens.endedSessions
        XCTAssertEqual(ended, [102], "the local end did not name the session that served the refreshed token")
        XCTAssertEqual(URLProtocolFixture.requests.count, 2, "no third attempt")
    }

    /// A request cancelled by the time Core's second 401 arrives (the member signed out, or signed in again)
    /// ends nothing: that answer belongs to a session that may already be gone.
    func testACancelledRequestEndsNoSession() async throws {
        let tokens = FakeTokens()
        let requester = try requester(tokens)
        let reply = await Task {
            _ = withUnsafeCurrentTask { $0?.cancel() }
            return await requester.endSession(servedBy: 102)
        }.value
        XCTAssertEqual(reply, .transport(.other))
        let localEnds = await tokens.localEnds
        XCTAssertEqual(localEnds, 0, "a cancelled request ended the session")

        let live = await requester.endSession(servedBy: 102)
        XCTAssertEqual(live, .signedOut, "a request still running ends the session that served its token")
        let ended = await tokens.endedSessions
        XCTAssertEqual(ended, [102])
    }

    /// A session end whose wipe failed is not reported as a clean one.
    func testASessionEndThatCouldNotWipeSaysSo() async throws {
        URLProtocolFixture.install(sequence: [unauthorized, unauthorized])
        let tokens = FakeTokens(keepsStoredCopy: true)
        let reply = try await requester(tokens).get(path: Self.path)
        XCTAssertEqual(reply, .signedOutNotWiped)
        let signOuts = await tokens.signOuts
        let localEnds = await tokens.localEnds
        XCTAssertEqual(signOuts, 0)
        XCTAssertEqual(localEnds, 1)

        URLProtocolFixture.install(sequence: [unauthorized, ok])
        let refused = try await requester(FakeTokens(refusesRefresh: true, keepsStoredCopy: true)).get(path: Self.path)
        XCTAssertEqual(refused, .signedOutNotWiped, "a refused refresh whose wipe failed")
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
    }

    func testRefusedRefreshIsSignedOutWithoutRetry() async throws {
        URLProtocolFixture.install(sequence: [unauthorized, ok])
        let reply = try await requester(FakeTokens(refusesRefresh: true)).get(path: Self.path)
        XCTAssertEqual(reply, .signedOut)
        XCTAssertEqual(URLProtocolFixture.requests.count, 1, "a refused refresh was followed by a retry")
    }

    func testUnreachableIdentityProviderSendsNothing() async throws {
        URLProtocolFixture.install(ok)
        let reply = try await requester(FakeTokens(unavailable: true)).get(path: Self.path)
        XCTAssertEqual(reply, .identityUnavailable)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }

    func testForbiddenIsNeitherRetriedNorASignOut() async throws {
        URLProtocolFixture.install(sequence: [.body(status: 403, headers: Self.headers, chunks: [Data("{}".utf8)]), ok])
        let tokens = FakeTokens()
        let reply = try await requester(tokens).get(path: Self.path)
        XCTAssertEqual(reply, .forbidden)
        XCTAssertEqual(URLProtocolFixture.requests.count, 1, "a 403 is not retried")
        let forced = await tokens.forcedRefreshes
        let signOuts = await tokens.signOuts
        let localEnds = await tokens.localEnds
        XCTAssertEqual(forced, 0)
        XCTAssertEqual(signOuts, 0)
        XCTAssertEqual(localEnds, 0)
    }

    /// Every other status is the caller's to map: no refresh, no retry, no session end.
    func testOtherStatusesGoToTheCaller() async throws {
        for status in [404, 429, 500, 503] {
            let body = Data("{}".utf8)
            URLProtocolFixture.install(.body(status: status, headers: Self.headers, chunks: [body]))
            let tokens = FakeTokens()
            let reply = try await requester(tokens).get(path: Self.path)
            XCTAssertEqual(reply, .answered(status: status, body: body), "\(status)")
            XCTAssertEqual(URLProtocolFixture.requests.count, 1, "\(status)")
            let forced = await tokens.forcedRefreshes
            let localEnds = await tokens.localEnds
            XCTAssertEqual(forced, 0, "\(status)")
            XCTAssertEqual(localEnds, 0, "\(status)")
        }
    }

    func testAnOversizedBodyIsNotHandedOn() async throws {
        URLProtocolFixture.install(.body(status: 200, headers: Self.headers,
                                         chunks: [Data(repeating: 32, count: StrictJSON.byteLimit + 1)]))
        let reply = try await requester(FakeTokens()).get(path: Self.path)
        XCTAssertEqual(reply, .tooLarge)

        let limit = Data(repeating: 32, count: StrictJSON.byteLimit)
        URLProtocolFixture.install(.body(status: 200, headers: Self.headers, chunks: [limit]))
        let atLimit = try await requester(FakeTokens()).get(path: Self.path)
        XCTAssertEqual(atLimit, .answered(status: 200, body: limit), "a body of exactly the limit is handed on")
    }

    func testOfflineIsATransportFailure() async throws {
        URLProtocolFixture.install(.failure(.notConnectedToInternet))
        let reply = try await requester(FakeTokens()).get(path: Self.path)
        XCTAssertEqual(reply, .transport(.offline))
    }

    func testRedirectIsNeverFollowedWithTheToken() async throws {
        #if canImport(FoundationNetworking)
        throw XCTSkip("swift-corelibs-foundation cannot deliver a URLProtocol redirect; the macOS job runs this")
        #else
        URLProtocolFixture.install(.redirect(status: 302, location: "https://elsewhere.test/api/v1/resource"))
        let clock = ContinuousClock()
        let start = clock.now
        // The transport timeout bounds the wait; the task must end well before it, with the 3xx.
        let reply = try await requester(FakeTokens(), timeout: 10).get(path: Self.path)
        XCTAssertLessThan(clock.now - start, .seconds(5), "the refused redirect only ended at the transport timeout")
        XCTAssertEqual(reply, .redirected)
        XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.absoluteString }, [Self.url.absoluteString],
                       "the redirect was followed")
        #endif
    }
}

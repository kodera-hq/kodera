import Foundation
import XCTest
import KoderaAuth
import KoderaDomain
@testable import Kodera
@testable import KoderaClient

private final class HarnessSignal: @unchecked Sendable {
    let expectation: XCTestExpectation
    private let lock = NSLock()
    private var finished = false
    init(_ name: String) { expectation = XCTestExpectation(description: name) }
    var isFinished: Bool { lock.withLock { finished } }
    func finish() {
        let first = lock.withLock { if finished { return false }; finished = true; return true }
        if first { expectation.fulfill() }
    }
}

/// Finite backend/transport script gate, never a production scheduling hook.
private final class HarnessGate: @unchecked Sendable {
    let entered = HarnessSignal("operation entered")
    private let lock = NSLock()
    private var open = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        entered.finish()
        await withCheckedContinuation { continuation in
            let resume = lock.withLock {
                if open { return true }
                self.continuation = continuation
                return false
            }
            if resume { continuation.resume() }
        }
    }
    func release() {
        let pending = lock.withLock {
            open = true
            let pending = continuation
            continuation = nil
            return pending
        }
        pending?.resume()
    }
}

private final class HarnessStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var faults = 0
    private var calls: [String] = []
    var bytes: Data? { lock.withLock { data } }
    var log: [String] { lock.withLock { calls } }
    func failNextWipes(_ count: Int) { lock.withLock { faults = count } }
    func clearLog() { lock.withLock { calls.removeAll() } }
    func load() throws(TokenStoreFailure) -> Data? { lock.withLock { calls.append("load"); return data } }
    func save(_ data: Data) throws(TokenStoreFailure) { lock.withLock { calls.append("save"); self.data = data } }
    func wipe() throws(TokenStoreFailure) {
        let failed = lock.withLock {
            if faults > 0 { faults -= 1; calls.append("wipe.failed"); return true }
            calls.append("wipe"); data = nil; return false
        }
        if failed { throw .keychain(-25_244) }
    }
}

private actor HarnessBackend: AuthorizationBackend {
    struct Calls: Sendable {
        var authorized = 0
        var grants: [StoredGrant] = []
        var forced: [Bool] = []
        var revoked: [StoredGrant] = []
    }
    private var calls = Calls()
    private var refusal: HarnessGate?
    private var revocation: HarnessGate?
    private var gates: [HarnessGate] = []
    func snapshot() -> Calls { calls }
    func refuseNextRefresh(_ gate: HarnessGate) { refusal = gate; gates.append(gate) }
    func holdRevocation(_ gate: HarnessGate) { revocation = gate; gates.append(gate) }
    func releaseAll() { for gate in gates { gate.release() } }
    func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure) -> StoredGrant {
        calls.authorized += 1
        return StoredGrant(issuer: issuer.issuer, archive: Data("G\(calls.authorized)".utf8))
    }
    func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken {
        calls.grants.append(grant); calls.forced.append(forceRefresh)
        if let gate = refusal {
            refusal = nil
            await gate.wait()
            throw .refused
        }
        return FreshToken(accessToken: "synthetic-" + String(decoding: grant.archive, as: UTF8.self), grant: grant)
    }
    func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async {
        calls.revoked.append(grant)
        if let gate = revocation { await gate.wait() }
    }
}

private final class HarnessRequest: @unchecked Sendable {
    let path: String
    let bearer: String
    let gate = HarnessGate()
    let stopped = HarnessSignal("URLProtocol stopLoading")
    let finished = HarnessSignal("URLProtocol worker finished")
    let registered = HarnessSignal("URLProtocol worker registered")
    init(path: String, bearer: String) { self.path = path; self.bearer = bearer }
}

/// A private per-session protocol always handles the request: unexpected routes fail locally.
private final class HarnessProtocol: URLProtocol, @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        let lock = NSLock()
        var scenario: HarnessHTTP?
    }
    private static let registry = Registry()
    private let stateLock = NSLock()
    private var stopped = false
    private var entry: HarnessRequest?
    static func install(_ scenario: HarnessHTTP?) { registry.lock.withLock { registry.scenario = scenario } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let scenario = Self.registry.lock.withLock({ Self.registry.scenario }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let entry = HarnessRequest(path: request.url?.path ?? "", bearer: request.value(forHTTPHeaderField: "Authorization") ?? "")
        stateLock.withLock { self.entry = entry }
        let route = (request.httpMethod == "GET" && [HarnessHTTP.memberPath, HarnessHTTP.workspacePath].contains(entry.path)) ||
            (request.httpMethod == "POST" && entry.path == HarnessHTTP.proximityPath)
        let valid = request.url?.scheme == "https" && request.url?.host == "core.kodera.test" && route &&
            ["Bearer synthetic-G1", "Bearer synthetic-G2"].contains(entry.bearer)
        let accepting = scenario.record(entry, valid: valid)
        guard valid && accepting else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            entry.registered.finish(); entry.finished.finish(); return
        }
        let worker = Task {
            await entry.gate.wait()
            if !stateLock.withLock({ stopped }) {
                if let url = request.url,
                   let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                                  headerFields: ["Content-Type": "application/json"]) {
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                    client?.urlProtocol(self, didLoad: scenario.body(for: entry))
                    client?.urlProtocolDidFinishLoading(self)
                } else { client?.urlProtocol(self, didFailWithError: URLError(.badURL)) }
            }
            entry.finished.finish()
        }
        scenario.retain(worker, entry: entry)
    }
    override func stopLoading() {
        let entry = stateLock.withLock { stopped = true; return self.entry }
        entry?.stopped.finish()
        entry?.gate.release()
    }
}

private final class HarnessHTTP: @unchecked Sendable {
    static let organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    static let memberPath = "/api/v1/me"
    static let workspacePath = "/api/v1/organisations/\(organisation)/workspace"
    static let proximityPath = "/api/v1/proximity/bootstrap"
    private let lock = NSLock()
    private var queued: [HarnessRequest] = []
    private var waiter: CheckedContinuation<HarnessRequest?, Never>?
    private var entries: [HarnessRequest] = []
    private var workers: [Task<Void, Never>] = []
    private var invalid = 0
    private var closing = false
    var all: [HarnessRequest] { lock.withLock { entries } }
    var invalidCount: Int { lock.withLock { invalid } }
    var tasks: [Task<Void, Never>] { lock.withLock { workers } }
    func retain(_ worker: Task<Void, Never>, entry: HarnessRequest) {
        lock.withLock { workers.append(worker) }
        entry.registered.finish()
    }
    func record(_ entry: HarnessRequest, valid: Bool) -> Bool {
        let pending: (Bool, CheckedContinuation<HarnessRequest?, Never>?) = lock.withLock {
            entries.append(entry)
            if !valid { invalid += 1 }
            if closing { return (false, nil) }
            let pending = waiter; waiter = nil
            if pending == nil { queued.append(entry) }
            return (true, pending)
        }
        pending.1?.resume(returning: entry)
        if !pending.0 { entry.gate.release() }
        return pending.0
    }
    func next() async -> HarnessRequest? {
        await withCheckedContinuation { continuation in
            let next: (HarnessRequest?, Bool) = lock.withLock {
                if closing { return (nil, true) }
                if !queued.isEmpty { return (queued.removeFirst(), true) }
                waiter = continuation; return (nil, false)
            }
            if next.1 { continuation.resume(returning: next.0) }
        }
    }
    func cancelWaiting() {
        let pending = lock.withLock { let pending = waiter; waiter = nil; return pending }
        pending?.resume(returning: nil)
    }
    func releaseAll() {
        let snapshot = lock.withLock {
            closing = true
            let pending = waiter; waiter = nil
            return (entries, pending)
        }
        snapshot.1?.resume(returning: nil)
        for entry in snapshot.0 { entry.gate.release() }
    }
    func body(for entry: HarnessRequest) -> Data {
        if entry.path == Self.proximityPath {
            let epoch = ProximityBounds.currentUnixSeconds() / 900
            return Data("""
            {"workspace_id":"0192f3a4-5b6c-7d8e-9f01-23456789abcd","event_scope":"default","epoch_mac_key":"\(String(repeating: "ab", count: 32))","epoch":\(epoch),"epoch_expires_at":\((epoch + 1) * 900),"epoch_rotation_seconds":900}
            """.utf8)
        }
        let label = entry.bearer.hasSuffix("G2") ? "G2" : "G1"
        if entry.path == Self.memberPath {
            return Data("""
            {"id":"11111111-2222-4333-8444-555555555555","email":"member@example.test","display_name":"\(label) Member","organisations":[{"organisation":{"id":"\(Self.organisation)","slug":"example","name":"Synthetic organisation","realm":"example"},"role":"org_owner","state":"active"}]}
            """.utf8)
        }
        return Data("""
        {"organisation_id":"\(Self.organisation)","state":"initialised","setup":{"state":"ready","reason":null},"can_initialise":false,"id":"0192f3a4-5b6c-7d8e-9f01-23456789abcd","categories":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abce","name":"\(label) Section","template_key":null,"channels":[]}],"uncategorised_channels":[]}
        """.utf8)
    }
}

private struct HarnessFailure: Error {}

@MainActor
private final class HarnessFactory {
    let service: KoderaSignInService
    var requesters: [CoreRequester] = []
    init(service: KoderaSignInService) { self.service = service }
    func make(origin: String, policy: LoopbackPolicy, supplied: any SignInService) throws -> CoreRequester {
        XCTAssertEqual(origin, "https://core.kodera.test")
        XCTAssertEqual(policy, AppConfiguration.loopback)
        XCTAssertTrue((supplied as AnyObject) === service)
        let requester = try CoreRequester(coreApiOrigin: origin, loopback: policy, tokens: supplied,
                                         protocolClass: HarnessProtocol.self, timeout: 5)
        requesters.append(requester)
        return requester
    }
}

@MainActor
private final class AppHarness {
    static let issuer = "https://auth.kodera.test/realms/example"
    let suite = "io.kodera.app.tests." + UUID().uuidString
    let defaults: UserDefaults
    let store = HarnessStore()
    let backend = HarnessBackend()
    let http = HarnessHTTP()
    let channels = OrganisationChannelsLoader()
    let service: KoderaSignInService
    let model: AppSessionModel
    let factory: HarnessFactory
    let configuration: AppConfiguration
    private var observations: [(Task<Void, Never>, HarnessSignal)] = []
    init(revocationWait: Duration = KoderaSignInService.revocationWaitLimit) throws {
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        configuration = AppConfiguration.read({ key in
            switch key {
            case "KoderaCoreOrigin": "https://core.kodera.test"
            case "KoderaIssuerOrigins": "https://auth.kodera.test"
            case "KoderaClientID": "synthetic-client"
            default: ""
            }
        }, loopback: .refuse, admitsDevelopmentIssuer: false)
        service = KoderaSignInService(configuration: try XCTUnwrap(configuration.signIn), store: store,
                                      backend: backend, revocationWait: revocationWait)
        factory = HarnessFactory(service: service)
        model = AppSessionModel(configuration: configuration, service: service, store: store, defaults: defaults,
                                channels: channels, requesterFactory: factory.make)
        HarnessProtocol.install(http)
        model.setForeground(true)
    }
    func seedPersistedGrant() async throws {
        let seed = KoderaSignInService(configuration: try XCTUnwrap(configuration.signIn), store: store,
                                       backend: HarnessBackend())
        _ = try await seed.signIn(issuer: Self.issuer)
        XCTAssertNotNil(store.bytes)
        store.clearLog()
    }
    func markInstalled() { defaults.set(true, forKey: FirstLaunch.markerKey) }
    var marked: Bool { defaults.bool(forKey: FirstLaunch.markerKey) }
    func wait(_ signal: HarnessSignal) async throws {
        if signal.isFinished { return }
        let result = await XCTWaiter.fulfillment(of: [signal.expectation], timeout: 5)
        guard result == .completed else { XCTFail("finite harness acknowledgement timed out"); throw HarnessFailure() }
    }
    @discardableResult func capture(_ task: Task<Void, Never>) -> HarnessSignal {
        let done = HarnessSignal("whole worker including reducer completed")
        let watcher = Task { await task.value; done.finish() }
        observations.append((watcher, done))
        return done
    }
    func processed(_ task: Task<Void, Never>) async throws { try await wait(capture(task)) }
    func start() async throws { try await processed(Task { await model.start() }) }
    func signIn() async throws {
        XCTAssertTrue(model.canSignIn)
        model.signIn(issuer: Self.issuer)
        XCTAssertEqual(model.phase, .signingIn)
        try await processed(try XCTUnwrap(model.signInTask))
    }
    func next(_ path: String, token: String) async throws -> HarnessRequest {
        let signal = HarnessSignal("actual HTTP request entered")
        let box = RequestBox()
        let waiter = Task { box.entry = await http.next(); signal.finish() }
        observations.append((waiter, signal))
        try await wait(signal)
        let entry = try XCTUnwrap(box.entry)
        XCTAssertEqual(entry.path, path)
        XCTAssertEqual(entry.bearer, "Bearer synthetic-" + token)
        XCTAssertEqual(http.invalidCount, 0)
        return entry
    }
    func complete(_ entry: HarnessRequest, task: Task<Void, Never>) async throws {
        let done = capture(task)
        entry.gate.release()
        try await wait(done)
        try await wait(entry.finished)
    }
    func load(_ token: String) async throws {
        let member = try await next(HarnessHTTP.memberPath, token: token)
        try await complete(member, task: try XCTUnwrap(channels.readTask))
        let workspace = try await next(HarnessHTTP.workspacePath, token: token)
        try await complete(workspace, task: try XCTUnwrap(channels.readTask))
        assertLoaded(token)
    }
    func assertLoaded(_ token: String) {
        XCTAssertEqual(model.member, .loaded(name: token + " Member", organisation: "Synthetic organisation"))
        guard case let .loaded(workspace) = model.workspace else { XCTFail("actual workspace was not decoded"); return }
        XCTAssertEqual(workspace.categories.first?.name, token + " Section")
        XCTAssertEqual(workspace.organisationId, HarnessHTTP.organisation)
        guard case let .signedIn(session) = model.phase else { XCTFail("actual App was not signed in"); return }
        XCTAssertEqual(session.issuer, Self.issuer)
        XCTAssertNil(model.noticeKey)
        XCTAssertFalse(factory.requesters.last?.isInvalidated ?? true)
    }
    func cleanup() async throws {
        defer {
            HarnessProtocol.install(nil)
            defaults.removePersistentDomain(forName: suite)
        }
        await backend.releaseAll()
        http.releaseAll()
        http.cancelWaiting()
        model.setForeground(false)
        for requester in factory.requesters { requester.invalidate() }
        var firstError: (any Error)?
        for (_, done) in observations {
            do { try await wait(done) } catch { if firstError == nil { firstError = error } }
        }
        for entry in http.all {
            do { try await wait(entry.registered) } catch { if firstError == nil { firstError = error } }
        }
        for worker in http.tasks {
            do { try await processed(worker) } catch { if firstError == nil { firstError = error } }
        }
        XCTAssertEqual(http.invalidCount, 0)
        if let firstError { throw firstError }
    }
}

@MainActor
private final class RequestBox { var entry: HarnessRequest? }

@MainActor
final class AppSessionModelTests: XCTestCase {
    private func exercise(revocationWait: Duration = KoderaSignInService.revocationWaitLimit,
                          _ body: @MainActor (AppHarness) async throws -> Void) async throws {
        let f = try AppHarness(revocationWait: revocationWait)
        do { try await body(f) }
        catch { try await f.cleanup(); throw error }
        try await f.cleanup()
    }

    func testActualCompositionSmoke() async throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "io.kodera.app")
        let host = AppConfiguration.bundled(in: .main)
        XCTAssertNil(host.signIn); XCTAssertNil(host.discoveryConfiguration); XCTAssertNil(host.coreApiOrigin)
        XCTAssertNil(host.developmentIssuer); XCTAssertNil(host.consoleOrigin)
        for key in ["KoderaCoreOrigin", "KoderaIssuerOrigins", "KoderaClientID", "KoderaDevelopmentIssuer", "KoderaConsoleOrigin"] {
            XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: key) as? String, "")
        }
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "KoderaOfflineAccess") as? String, "NO")
        try await exercise { f in
            f.markInstalled()
            try await f.start()
            XCTAssertEqual(f.model.phase, .signedOut)
            try await f.signIn(); try await f.load("G1")
            XCTAssertEqual(f.factory.requesters.count, 1)
            XCTAssertEqual(f.http.all.map(\.path), [HarnessHTTP.memberPath, HarnessHTTP.workspacePath])
            let calls = await f.backend.snapshot()
            XCTAssertEqual(calls.authorized, 1); XCTAssertEqual(calls.forced, [false, false])
        }
    }

    func testNewInstallWipesBeforeRestore() async throws {
        try await exercise { f in
            try await f.seedPersistedGrant()
            XCTAssertFalse(f.marked)
            try await f.start()
            XCTAssertEqual(f.store.log, ["wipe", "load"])
            XCTAssertTrue(f.marked); XCTAssertNil(f.store.bytes)
            XCTAssertEqual(f.model.phase, .signedOut)
            let calls = await f.backend.snapshot()
            XCTAssertEqual(calls.authorized, 0); XCTAssertTrue(calls.forced.isEmpty)
            XCTAssertTrue(f.http.all.isEmpty)
        }
    }

    func testNewInstallWipeFailureStopsRestore() async throws {
        try await exercise { f in
            try await f.seedPersistedGrant()
            let retained = f.store.bytes
            f.store.failNextWipes(1)
            try await f.start()
            XCTAssertEqual(f.store.log, ["wipe.failed"]); XCTAssertEqual(f.store.bytes, retained)
            XCTAssertFalse(f.marked); XCTAssertEqual(f.model.phase, .signedOut)
            XCTAssertEqual(f.model.noticeKey, "signin.storage")
            let calls = await f.backend.snapshot()
            XCTAssertEqual(calls.authorized, 0); XCTAssertTrue(calls.forced.isEmpty)
            XCTAssertTrue(f.http.all.isEmpty)
        }
    }

    func testMarkedInstallResumesAndLoadsWorkspace() async throws {
        try await exercise { f in
            try await f.seedPersistedGrant(); f.markInstalled()
            try await f.start(); try await f.load("G1")
            XCTAssertEqual(f.store.log, ["load"])
            let calls = await f.backend.snapshot()
            XCTAssertEqual(calls.authorized, 0); XCTAssertEqual(calls.forced, [true, false, false])
            XCTAssertEqual(Set(calls.grants.map(\.archive)), [Data("G1".utf8)])
            XCTAssertTrue(f.marked)
        }
    }

    func testPublicActionsAndForegroundReuse() async throws {
        try await exercise { f in
            f.markInstalled(); try await f.start(); try await f.signIn(); try await f.load("G1")
            let first = try XCTUnwrap(f.factory.requesters.first)
            f.model.setForeground(false); f.model.setForeground(true)
            try await f.load("G1")
            XCTAssertEqual(f.factory.requesters.count, 1); XCTAssertFalse(first.isInvalidated)
            f.model.retryChannels(); try await f.load("G1")
            f.model.signOut(); XCTAssertEqual(f.model.phase, .signedOut); XCTAssertTrue(first.isInvalidated)
            try await f.processed(try XCTUnwrap(f.model.signOutTask))
            try await f.signIn(); try await f.load("G2")
            XCTAssertEqual(f.factory.requesters.count, 2)
            XCTAssertFalse(first === f.factory.requesters.last)
        }
    }

    private func cancelledOldRead(workspace: Bool) async throws {
        try await exercise { f in
            f.markInstalled(); try await f.start(); try await f.signIn()
            let member = try await f.next(HarnessHTTP.memberPath, token: "G1")
            let entry: HarnessRequest
            if workspace {
                try await f.complete(member, task: try XCTUnwrap(f.channels.readTask))
                entry = try await f.next(HarnessHTTP.workspacePath, token: "G1")
            } else { entry = member }
            let oldDone = f.capture(try XCTUnwrap(f.channels.readTask))
            XCTAssertFalse(oldDone.isFinished)
            let old = try XCTUnwrap(f.factory.requesters.first)
            f.model.signOut()
            XCTAssertTrue(old.isInvalidated)
            try await f.wait(entry.stopped); try await f.wait(oldDone)
            XCTAssertTrue(entry.stopped.isFinished); XCTAssertTrue(oldDone.isFinished)
            entry.gate.release(); try await f.wait(entry.finished)
            try await f.processed(try XCTUnwrap(f.model.signOutTask))
            try await f.signIn(); try await f.load("G2")
            XCTAssertEqual(f.factory.requesters.count, 2)
            XCTAssertTrue(old.isInvalidated); XCTAssertTrue(f.marked)
        }
    }

    func testCancelledOldMemberAllowsG2() async throws { try await cancelledOldRead(workspace: false) }
    func testCancelledOldWorkspaceAllowsG2() async throws { try await cancelledOldRead(workspace: true) }

    func testOldSignOutCompletionCannotEndG2() async throws {
        try await exercise(revocationWait: .zero) { f in
            f.markInstalled(); try await f.start(); try await f.signIn(); try await f.load("G1")
            let retained = try XCTUnwrap(f.store.bytes)
            let old = try XCTUnwrap(f.factory.requesters.first)
            let revoke = HarnessGate()
            await f.backend.holdRevocation(revoke)
            f.store.failNextWipes(1)
            f.model.signOut()
            let oldDone = f.capture(try XCTUnwrap(f.model.signOutTask))
            try await f.wait(revoke.entered)
            XCTAssertEqual(f.model.phase, .signedOut); XCTAssertTrue(f.model.canSignIn)
            XCTAssertTrue(old.isInvalidated); XCTAssertEqual(f.store.bytes, retained)
            XCTAssertEqual(f.store.log.last, "wipe.failed"); XCTAssertFalse(oldDone.isFinished)
            try await f.signIn(); try await f.load("G2")
            XCTAssertFalse(oldDone.isFinished); XCTAssertTrue(revoke.entered.isFinished)
            XCTAssertTrue(f.marked); XCTAssertEqual(f.channels.terminalStrength, .none)
            let phase = f.model.phase, member = f.model.member, workspace = f.model.workspace
            let current = try XCTUnwrap(f.factory.requesters.last)
            let calls = await f.backend.snapshot(), storeCalls = f.store.log
            XCTAssertTrue(f.http.all.suffix(2).allSatisfy { $0.bearer == "Bearer synthetic-G2" })
            revoke.release(); try await f.wait(oldDone)
            XCTAssertEqual(f.model.phase, phase); XCTAssertEqual(f.model.member, member)
            XCTAssertEqual(f.model.workspace, workspace); XCTAssertFalse(current.isInvalidated)
            XCTAssertTrue(f.marked); XCTAssertNil(f.model.noticeKey); XCTAssertEqual(f.channels.terminalStrength, .none)
            XCTAssertEqual(f.store.log, storeCalls)
            let after = await f.backend.snapshot()
            XCTAssertEqual(after.authorized, calls.authorized); XCTAssertEqual(after.forced, calls.forced)
            XCTAssertEqual(after.revoked, calls.revoked)
        }
    }

    func testCurrentLateFailedWipeRearmsNextLaunch() async throws {
        try await exercise { f in
            try await f.seedPersistedGrant(); f.markInstalled()
            try await f.start(); try await f.load("G1")
            let retained = try XCTUnwrap(f.store.bytes)
            let refusal = HarnessGate()
            await f.backend.refuseNextRefresh(refusal)
            f.model.reloadMember()
            let done = f.capture(try XCTUnwrap(f.channels.readTask))
            try await f.wait(refusal.entered)
            XCTAssertFalse(done.isFinished)
            f.model.setForeground(false)
            f.store.failNextWipes(1)
            refusal.release(); try await f.wait(done)
            XCTAssertEqual(f.model.phase, .signedOut); XCTAssertEqual(f.model.noticeKey, "session.not_wiped")
            XCTAssertEqual(f.channels.terminalStrength, .signedOutNotWiped)
            XCTAssertEqual(f.store.bytes, retained); XCTAssertEqual(f.store.log.last, "wipe.failed")
            guard !f.marked else { XCTFail("InstallMarkerNotClearedAfterRealFailedWipe"); return }
            let prior = f.store.log
            f.model.signOut(); f.model.reloadMember(); f.model.setForeground(true); f.model.retryChannels()
            XCTAssertEqual(f.store.log, prior); XCTAssertFalse(f.marked)
            let backend = HarnessBackend(), channels = OrganisationChannelsLoader()
            let service = KoderaSignInService(configuration: try XCTUnwrap(f.configuration.signIn), store: f.store, backend: backend)
            let factory = HarnessFactory(service: service)
            let next = AppSessionModel(configuration: f.configuration, service: service, store: f.store,
                                       defaults: f.defaults, channels: channels, requesterFactory: factory.make)
            f.store.clearLog(); f.store.failNextWipes(1)
            try await f.processed(Task { await next.start() })
            XCTAssertEqual(f.store.log, ["wipe.failed"])
            XCTAssertEqual(next.phase, .signedOut); XCTAssertEqual(next.noticeKey, "signin.storage")
            XCTAssertFalse(f.marked); XCTAssertEqual(f.store.bytes, retained)
            let calls = await backend.snapshot()
            XCTAssertEqual(calls.authorized, 0); XCTAssertTrue(calls.forced.isEmpty)
            XCTAssertTrue(factory.requesters.isEmpty)
        }
    }
}

@MainActor
final class ProximityCompositionTests: XCTestCase {
    private func exercise(_ body: @MainActor (AppHarness) async throws -> Void) async throws {
        let fixture = try AppHarness()
        do { try await body(fixture) }
        catch { try await fixture.cleanup(); throw error }
        try await fixture.cleanup()
    }

    private func awaitPreparation(_ model: AppSessionModel) async throws {
        for _ in 0..<500 {
            if !model.isPreparingProximity { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("bounded authenticated radio preparation did not settle")
        throw HarnessFailure()
    }

    func testExplicitConsentBindsWorkspaceMaterialAndBackgroundClearsItWithoutScanning() async throws {
        try await exercise { fixture in
            try await fixture.start()
            try await fixture.signIn()
            try await fixture.load("G1")
            XCTAssertNil(fixture.model.proximityRadioSession.organisationId)
            fixture.model.prepareProximity()
            let request = try await fixture.next(HarnessHTTP.proximityPath, token: "G1")
            request.gate.release()
            try await fixture.wait(request.finished)
            try await awaitPreparation(fixture.model)
            XCTAssertNil(fixture.model.proximityPreparationErrorKey)
            XCTAssertEqual(fixture.model.proximityRadioSession.organisationId, "0192f3a4-5b6c-7d8e-9f01-23456789abcd")
            XCTAssertTrue(fixture.model.proximityRadioSession.hasForegroundConsent)
            XCTAssertFalse(fixture.model.proximityRadioSession.isSessionActive)
            fixture.model.setForeground(false)
            XCTAssertNil(fixture.model.proximityRadioSession.organisationId)
            XCTAssertFalse(fixture.model.proximityRadioSession.hasForegroundConsent)
            XCTAssertNil(fixture.model.proximityRadioSession.activeTokenHex)
        }
    }

    func testOldOwnerBootstrapCannotGrantRadioConsentToReplacementSession() async throws {
        try await exercise { fixture in
            try await fixture.start()
            try await fixture.signIn()
            try await fixture.load("G1")
            fixture.model.prepareProximity()
            let old = try await fixture.next(HarnessHTTP.proximityPath, token: "G1")
            fixture.model.signOut()
            try await fixture.processed(try XCTUnwrap(fixture.model.signOutTask))
            try await fixture.signIn()
            try await fixture.load("G2")
            old.gate.release()
            try await fixture.wait(old.finished)
            XCTAssertFalse(fixture.model.isPreparingProximity)
            XCTAssertNil(fixture.model.proximityRadioSession.organisationId)
            XCTAssertFalse(fixture.model.proximityRadioSession.hasForegroundConsent)
            fixture.assertLoaded("G2")
        }
    }
}

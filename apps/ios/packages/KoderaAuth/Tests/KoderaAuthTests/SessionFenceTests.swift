import Foundation
import XCTest
import KoderaClient
import KoderaDomain
@testable import KoderaAuth

/// A backend whose refresh waits at a gate until the test opens it, so a sign-out or a new sign-in can
/// land while a refresh is in flight. It also records what the store held when revocation was asked for,
/// and, when told to, holds revocation at a second gate.
private actor GatedBackend: AuthorizationBackend {
    private let store: InMemoryTokenStore
    private let refresh: Result<FreshToken, BackendFailure>
    private var gate: CheckedContinuation<Void, Never>?
    /// Latched: a refresh that reaches the gate after it opened goes straight through, so no test can hang here.
    private var opened = false
    private var revocationGate: CheckedContinuation<Void, Never>?
    /// Latched like `opened`; true unless the test holds revocation.
    private var revocationOpened: Bool
    private var signIns = 0
    private(set) var entered = false
    private(set) var revoked: [StoredGrant] = []
    private(set) var storeAtRevoke: [Data?] = []
    /// Browser and revocation calls in order: "authorize grant-N" when a sign-in's browser step returns
    /// grant-N, "revoke X" when a revocation of X starts, "revoked X" when it ends.
    private(set) var events: [String] = []

    init(store: InMemoryTokenStore, refresh: Result<FreshToken, BackendFailure>, holdsRevocation: Bool = false) {
        self.store = store
        self.refresh = refresh
        revocationOpened = !holdsRevocation
    }

    func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure)
        -> StoredGrant {
        signIns += 1
        events.append("authorize grant-\(signIns)")
        return StoredGrant(issuer: issuer.issuer, archive: Data("grant-\(signIns)".utf8))
    }

    func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken {
        entered = true
        if !opened {
            await withCheckedContinuation { continuation in gate = continuation }
        }
        return try refresh.get()
    }

    func open() {
        opened = true
        gate?.resume()
        gate = nil
    }

    func openRevocation() {
        revocationOpened = true
        revocationGate?.resume()
        revocationGate = nil
    }

    func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async {
        let name = String(decoding: grant.archive, as: UTF8.self)
        events.append("revoke \(name)")
        revoked.append(grant)
        storeAtRevoke.append(try? store.load())
        if !revocationOpened {
            await withCheckedContinuation { continuation in revocationGate = continuation }
        }
        events.append("revoked \(name)")
    }
}

/// A bounded wait's deadline passed. The test has already failed, by name.
private struct DeadlinePassed: Error {
    let what: String
}

/// The first of an operation's result and a deadline, whichever comes first; later ones are ignored.
private final class FirstResult<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var early: Result<T, any Error>?
    private var waiter: CheckedContinuation<T, any Error>?

    func finish(_ result: Result<T, any Error>) {
        let waiting: CheckedContinuation<T, any Error>? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            guard let waiter else {
                early = result
                return nil
            }
            self.waiter = nil
            return waiter
        }
        waiting?.resume(with: result)
    }

    func value() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let ready: Result<T, any Error>? = lock.withLock {
                if let early { return early }
                waiter = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }
    }
}

/// Records the session-ended signals, with what the store held when each was told. A listener runs on the
/// service's actor, synchronously, inside the call that ended the session, so the log is final once that
/// call returns: no test here waits for it.
private final class EndedLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [SessionEnded] = []
    private var stored: [Data?] = []
    private var mark = 0
    private let store: (any TokenStore)?

    init(store: (any TokenStore)? = nil) { self.store = store }

    func record(_ event: SessionEnded) {
        let held: Data? = (try? store?.load()) ?? nil
        lock.withLock {
            events.append(event)
            stored.append(held)
        }
    }

    /// The signals since the last call: each assertion counts only what the step before it did.
    func sinceLast() -> [SessionEnded] {
        lock.withLock {
            defer { mark = events.count }
            return Array(events[mark...])
        }
    }

    /// What the store held when the last signal was told.
    var storedAtLast: Data?? { lock.withLock { stored.last } }
}

/// Keeps the first grant it is given and refuses every later save, as a Keychain that cannot take the
/// rotated grant.
private final class RefusesRotationStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var saves = 0
    func load() throws(TokenStoreFailure) -> Data? { lock.withLock { data } }
    func save(_ data: Data) throws(TokenStoreFailure) {
        let refused = lock.withLock { () -> Bool in
            saves += 1
            guard saves == 1 else { return true }
            self.data = data
            return false
        }
        if refused { throw .keychain(-34_018) }
    }
    func wipe() throws(TokenStoreFailure) { lock.withLock { data = nil } }
}

/// Keeps what it is given and cannot delete it, like a Keychain item a failed delete left behind.
private final class UndeletableStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func load() throws(TokenStoreFailure) -> Data? { lock.withLock { data } }
    func save(_ data: Data) throws(TokenStoreFailure) { lock.withLock { self.data = data } }
    func wipe() throws(TokenStoreFailure) { throw .keychain(-25_244) }
}

/// Refuses every save: no grant can be kept.
private final class RefusesSaveStore: TokenStore, @unchecked Sendable {
    func load() throws(TokenStoreFailure) -> Data? { nil }
    func save(_ data: Data) throws(TokenStoreFailure) { throw .keychain(-34_018) }
    func wipe() throws(TokenStoreFailure) {}
}

final class SessionFenceTests: XCTestCase {
    private static let issuer = "https://auth.kodera.test/realms/acme-sa"

    /// `signOutWait` short by default here: these tests hold the refresh past it on purpose.
    private func service(_ backend: GatedBackend, store: any TokenStore,
                         signOutWait: Duration = .milliseconds(50),
                         revocationWait: Duration = .seconds(15)) throws -> KoderaSignInService {
        KoderaSignInService(configuration: try SignInConfiguration(clientID: "kodera-ios",
            admittedIssuerOrigins: ["https://auth.kodera.test"], loopback: .refuse), store: store, backend: backend,
            signOutWait: signOutWait, revocationWait: revocationWait)
    }

    /// Every wait here is bounded: a regression fails the test, it never hangs the suite.
    ///
    /// Races `operation` against a deadline. Past it the test fails, naming what did not finish, and the
    /// stuck operation is cancelled and left behind rather than awaited: a task group would wait for it.
    private func bounded<T: Sendable>(_ what: String, within limit: Duration = .seconds(5),
                                      file: StaticString = #filePath, line: UInt = #line,
                                      _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let first = FirstResult<T>()
        let work = Task {
            do {
                let value = try await operation()
                first.finish(.success(value))
            } catch { first.finish(.failure(error)) }
        }
        let deadline = Task {
            do { try await Task.sleep(for: limit) } catch { return }
            first.finish(.failure(DeadlinePassed(what: what)))
        }
        defer { deadline.cancel() }
        do { return try await first.value() } catch let passed as DeadlinePassed {
            work.cancel()
            XCTFail("\(passed.what) did not finish within \(limit)", file: file, line: line)
            throw passed
        }
    }

    /// Polls `condition` until it holds; past the deadline the test fails by name.
    private func until(_ what: String, within limit: Duration = .seconds(5),
                       file: StaticString = #filePath, line: UInt = #line,
                       _ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + limit
        while !(await condition()) {
            if ContinuousClock.now > deadline {
                XCTFail("\(what): not within \(limit)", file: file, line: line)
                throw DeadlinePassed(what: what)
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    private func signIn(_ service: KoderaSignInService, file: StaticString = #filePath,
                        line: UInt = #line) async throws -> Session {
        let issuer = Self.issuer
        return try await bounded("the sign-in", file: file, line: line) { try await service.signIn(issuer: issuer) }
    }

    private func signOut(_ service: KoderaSignInService, file: StaticString = #filePath,
                         line: UInt = #line) async throws {
        try await bounded("the sign-out", file: file, line: line) { try await service.signOut() }
    }

    private func waitUntilRefreshing(_ backend: GatedBackend, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await backend.entered) {
            if ContinuousClock.now > deadline { return XCTFail("the refresh never started", file: file, line: line) }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// True once sign-out queues behind the refresh; false after a bounded wait, so a sign-out that does not
    /// wait fails the test instead of hanging it.
    private func signOutQueues(_ service: KoderaSignInService) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while await service.queuedForRefresh == 0 {
            if ContinuousClock.now > deadline { return false }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return true
    }

    /// The success branch of the generation fence (`guard generation == started`): a refresh that
    /// finishes after a sign-out (one that stopped waiting for it) returns no token and writes nothing back.
    func testSignOutDuringARefreshCannotBeUndoneByIt() async throws {
        let store = InMemoryTokenStore()
        let late = StoredGrant(issuer: Self.issuer, archive: Data("late-grant".utf8))
        let backend = GatedBackend(store: store, refresh: .success(FreshToken(accessToken: "late", grant: late)))
        let service = try service(backend, store: store)
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)

        try await signOut(service)
        await backend.open()

        do {
            let token = try await bounded("the late refresh") { try await pending.value }
            XCTFail("a token after sign-out: \(token.value)")
        } catch {
            XCTAssertEqual(error as? AccessTokenFailure, .signedOut)
        }
        XCTAssertNil(try store.load(), "the late refresh wrote the session back")
        let restored = await service.restore()
        XCTAssertNil(restored)
        let revoked = await backend.revoked
        XCTAssertEqual(revoked.map(\.archive), [Data("grant-1".utf8)],
                       "the sign-out revokes; the late rotation is dropped, never revoked")
    }

    /// Sign-out wipes the Keychain before it asks the provider anything: the session is gone locally even
    /// if revocation never answers.
    func testSignOutWipesBeforeItRevokes() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable))
        let service = try service(backend, store: store)
        _ = try await signIn(service)
        XCTAssertNotNil(try store.load())
        try await signOut(service)
        let atRevoke = await backend.storeAtRevoke
        XCTAssertEqual(atRevoke.count, 1)
        XCTAssertNil(atRevoke.first ?? nil, "revoked while the Keychain still held the session")
    }

    /// Sign-out waits for a refresh in flight, so what it revokes is the grant that refresh rotated to,
    /// not the spent one.
    func testSignOutWaitsForARefreshAndRevokesTheRotatedGrant() async throws {
        let store = InMemoryTokenStore()
        let rotated = StoredGrant(issuer: Self.issuer, archive: Data("rotated-grant".utf8))
        let backend = GatedBackend(store: store, refresh: .success(FreshToken(accessToken: "fresh", grant: rotated)))
        let service = try service(backend, store: store, signOutWait: .seconds(30))
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)

        let signingOut = Task { try await service.signOut() }
        let queued = await signOutQueues(service)
        XCTAssertTrue(queued, "sign-out did not wait for the refresh in flight")
        await backend.open()

        let token = try await bounded("the refresh") { try await pending.value }
        XCTAssertEqual(token.value, "fresh", "the refresh finished before the sign-out")
        try await bounded("the sign-out") { try await signingOut.value }
        let revoked = await backend.revoked
        XCTAssertEqual(revoked, [rotated], "the spent grant was revoked instead of the live one")
        XCTAssertNil(try store.load())
        let restored = await service.restore()
        XCTAssertNil(restored)
    }

    /// The refused branch of the fence (`if generation == started`): a refusal that lands after the member
    /// signed out and back in belongs to the old grant, and must not wipe the new session.
    func testALateRefusalLeavesTheSessionThatReplacedItAlone() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.refused))
        let service = try service(backend, store: store)
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)

        try await signOut(service)
        let again = try await signIn(service)
        XCTAssertEqual(again.realm, "acme-sa")
        await backend.open()

        do {
            let token = try await bounded("the late refusal") { try await pending.value }
            XCTFail("a token from a refused refresh: \(token.value)")
        } catch {
            XCTAssertEqual(error as? AccessTokenFailure, .signedOut)
        }
        let stored = try XCTUnwrap(try store.load(), "the late refusal wiped the new session")
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Data("grant-2".utf8).base64EncodedString()))
        let restored = await service.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))
    }

    /// A sign-out still waiting for a refresh when the member signs in again: the sign-in drops the grant
    /// the sign-out was to end and revokes it before the browser opens, when no new grant exists yet. The
    /// sign-out, when it wakes, finds nothing of its own to end, so the old grant is revoked exactly once
    /// and the new session is left alone.
    func testASignInThatOvertakesAWaitingSignOutRevokesTheOldGrantFirst() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable))
        let service = try service(backend, store: store, signOutWait: .seconds(30))
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)
        let signingOut = Task { try await service.signOut() }
        let queued = await signOutQueues(service)
        XCTAssertTrue(queued, "sign-out did not wait for the refresh in flight")

        let again = try await signIn(service)
        XCTAssertEqual(again, Session(issuer: Self.issuer, realm: "acme-sa"), "the new sign-in did not proceed")
        let events = await backend.events
        XCTAssertEqual(events, ["authorize grant-1", "revoke grant-1", "revoked grant-1", "authorize grant-2"],
                       "the old grant was not revoked before the browser opened again")
        let atRevoke = await backend.storeAtRevoke
        XCTAssertEqual(atRevoke, [nil], "revoked while the Keychain still held the old grant")

        await backend.open()
        _ = try? await bounded("the refresh") { try await pending.value }
        try await bounded("the sign-out") { try await signingOut.value }
        let revoked = await backend.revoked
        XCTAssertEqual(revoked.map(\.archive), [Data("grant-1".utf8)], "the old grant is revoked exactly once")
        let stored = try XCTUnwrap(try store.load(), "the overtaken sign-out wiped the new session")
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Data("grant-2".utf8).base64EncodedString()))
        let restored = await service.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))
    }

    /// Keycloak detaches this client from every session the member has, so a sign-out's revocation that
    /// lands after the next sign-in would end that one too. The sign-in waits for it before the browser opens.
    func testASignInWaitsForTheSignOutsRevocationBeforeTheBrowserOpens() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable), holdsRevocation: true)
        let service = try service(backend, store: store)
        _ = try await signIn(service)
        let signingOut = Task { try await service.signOut() }
        try await until("the sign-out's revocation started") { await backend.revoked.count == 1 }

        let issuer = Self.issuer
        let signingIn = Task { try await service.signIn(issuer: issuer) }
        try await until("the sign-in waiting for the revocation") { await service.awaitingRevocation == 1 }
        let early = await backend.events
        XCTAssertEqual(early, ["authorize grant-1", "revoke grant-1"],
                       "the browser opened while the revocation was in flight")

        await backend.openRevocation()
        let again = try await bounded("the sign-in") { try await signingIn.value }
        XCTAssertEqual(again, Session(issuer: Self.issuer, realm: "acme-sa"))
        try await bounded("the sign-out") { try await signingOut.value }
        let events = await backend.events
        XCTAssertEqual(events, ["authorize grant-1", "revoke grant-1", "revoked grant-1", "authorize grant-2"])
        let stored = try XCTUnwrap(try store.load())
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Data("grant-2".utf8).base64EncodedString()))
    }

    /// The wait for a revocation is bounded: a provider that never answers cannot hold the next sign-in.
    /// Past the limit the browser opens anyway, and the revocation, still running, is left to finish.
    func testASignInStopsWaitingForARevocationPastItsLimit() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable), holdsRevocation: true)
        let service = try service(backend, store: store, revocationWait: .milliseconds(100))
        _ = try await signIn(service)
        let signingOut = Task { try await service.signOut() }
        try await until("the sign-out's revocation started") { await backend.revoked.count == 1 }

        let again = try await signIn(service)
        XCTAssertEqual(again, Session(issuer: Self.issuer, realm: "acme-sa"))
        let events = await backend.events
        XCTAssertEqual(events, ["authorize grant-1", "revoke grant-1", "authorize grant-2"],
                       "the sign-in did not open the browser once the revocation's limit passed")
        let waiting = await service.awaitingRevocation
        XCTAssertEqual(waiting, 0)

        await backend.openRevocation()
        try await bounded("the sign-out") { try await signingOut.value }
        let stored = try XCTUnwrap(try store.load(), "the late revocation's sign-out wiped the new session")
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Data("grant-2".utf8).base64EncodedString()))
    }

    // MARK: the session-ended hook

    /// Registers a recording listener, as A2 registers the one that ends the Matrix session.
    private func listening(_ service: KoderaSignInService, store: (any TokenStore)? = nil) async throws -> EndedLog {
        let ended = EndedLog(store: store)
        try await bounded("registering the listener") { await service.addSessionEndedListener { ended.record($0) } }
        return ended
    }

    /// The one signal the step before told, with `cause` (and `session`, when given). Nil, after a failure
    /// naming `what`, when there was not exactly one.
    @discardableResult
    private func assertEnded(_ ended: EndedLog, _ cause: SessionEndCause, session: UInt64? = nil, _ what: String,
                             file: StaticString = #filePath, line: UInt = #line) -> SessionEnded? {
        let events = ended.sinceLast()
        guard events.count == 1, let event = events.first else {
            XCTFail("\(what): \(events.count) signals, not one: \(events)", file: file, line: line)
            return nil
        }
        XCTAssertEqual(event.cause, cause, "\(what): the wrong cause", file: file, line: line)
        if let session {
            XCTAssertEqual(event.session, session, "\(what): the wrong session", file: file, line: line)
        }
        return event
    }

    private func assertSilent(_ ended: EndedLog, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let events = ended.sinceLast()
        XCTAssertEqual(events, [], "\(what): \(events.count) signals", file: file, line: line)
    }

    /// The session the service holds now, as its tokens carry it.
    private func heldSession(_ service: KoderaSignInService, file: StaticString = #filePath,
                             line: UInt = #line) async throws -> UInt64 {
        try await bounded("a token for the held session", file: file, line: line) {
            try await service.accessToken(forceRefresh: false)
        }.session
    }

    /// A backend whose refresh hands a token back at once, so a test can read the session a token carries.
    private func servingBackend(_ store: InMemoryTokenStore) async throws -> GatedBackend {
        let rotated = StoredGrant(issuer: Self.issuer, archive: Data("rotated-grant".utf8))
        let backend = GatedBackend(store: store, refresh: .success(FreshToken(accessToken: "fresh", grant: rotated)))
        try await bounded("opening the refresh gate") { await backend.open() }
        return backend
    }

    private func refreshRefused(_ service: KoderaSignInService, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) async {
        do {
            let token = try await bounded(what, file: file, line: line) {
                try await service.accessToken(forceRefresh: true)
            }
            XCTFail("\(what): a token \(token.value)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? AccessTokenFailure, .signedOut, what, file: file, line: line)
        }
    }

    private func assertStoreHolds(_ store: InMemoryTokenStore, _ grant: String, _ message: String,
                                  file: StaticString = #filePath, line: UInt = #line) throws {
        let stored = try XCTUnwrap(try store.load(), message, file: file, line: line)
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Data(grant.utf8).base64EncodedString()),
                      message, file: file, line: line)
    }

    /// The explicit sign-out ends the session once, as `.explicitSignOut`, with the session its tokens
    /// carried; a second sign-out, with nothing signed in, ends nothing.
    func testTheHookFiresOnceForAnExplicitSignOut() async throws {
        let store = InMemoryTokenStore()
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        assertSilent(ended, "a sign-in with nothing held reported an ended session")
        let held = try await heldSession(service)
        try await signOut(service)
        assertEnded(ended, .explicitSignOut, session: held, "the sign-out")
        try await signOut(service)
        assertSilent(ended, "a sign-out with nothing signed in reported an ended session")
    }

    /// A refused refresh ends the session once, as `.refreshRefused`; a refresh asked for afterwards finds
    /// nothing to end.
    func testTheHookFiresOnceForARefusedRefresh() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.refused))
        try await bounded("opening the refresh gate") { await backend.open() }
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        await refreshRefused(service, "the refused refresh")
        assertEnded(ended, .refreshRefused, "the refused refresh")
        await refreshRefused(service, "a refresh after the session ended")
        assertSilent(ended, "a refresh with nothing signed in reported an ended session")
    }

    /// Core's second 401 ends the session that served the token, once, as `.endedByServer`, with that
    /// token's session; the same refusal again ends nothing.
    func testTheHookFiresOnceForCoresSecondRefusal() async throws {
        let store = InMemoryTokenStore()
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        let token = try await bounded("the refresh") { try await service.accessToken(forceRefresh: true) }
        assertSilent(ended, "a refresh that rotated the grant reported an ended session")
        let served = token.session
        try await bounded("Core's second 401") { try await service.endSessionLocally(servedBy: served) }
        assertEnded(ended, .endedByServer, session: served, "Core's second 401")
        XCTAssertNil(try store.load())
        try await bounded("the same 401 again") { try await service.endSessionLocally(servedBy: served) }
        assertSilent(ended, "a 401 for a session already ended reported it again")
    }

    /// Two sessions in a row in one process are told apart: each signal carries its own session's identity,
    /// the one its tokens carried, and the two differ.
    func testTwoSessionsInARowReportDifferentIdentities() async throws {
        let store = InMemoryTokenStore()
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        let first = try await heldSession(service)
        try await signOut(service)
        let firstEnd = assertEnded(ended, .explicitSignOut, session: first, "the first session's sign-out")

        _ = try await signIn(service)
        let second = try await heldSession(service)
        XCTAssertNotEqual(second, first, "two sessions in a row carried the same identity")
        try await bounded("Core's second 401") { try await service.endSessionLocally(servedBy: second) }
        let secondEnd = assertEnded(ended, .endedByServer, session: second, "the second session's 401")
        XCTAssertNotEqual(firstEnd?.session, secondEnd?.session, "two ended sessions were reported as one")
    }

    /// A sign-in that replaces a held session ends it, once, as `.replaced`, with the old session's identity,
    /// and before the new session is held: when the listener is told, the old grant is wiped and the new one
    /// not yet stored. The same holds for a stored copy a previous launch left in the Keychain.
    func testTheHookFiresOnceForAReplacedSession() async throws {
        let store = InMemoryTokenStore()
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service, store: store)
        _ = try await signIn(service)
        let old = try await heldSession(service)
        _ = try await signIn(service)
        let replaced = assertEnded(ended, .replaced, session: old, "the sign-in that replaced a held session")
        XCTAssertNotNil(replaced)
        XCTAssertEqual(ended.storedAtLast, .some(nil), "the replaced session was reported once the new one was held")
        try assertStoreHolds(store, "grant-2", "the replacing sign-in did not keep its own grant")
        let new = try await heldSession(service)
        XCTAssertNotEqual(new, old, "the new session carries the replaced session's identity")

        // The next launch: the stored copy is a session too, even before anything restored it.
        let relaunched = try self.service(GatedBackend(store: store, refresh: .failure(.unavailable)), store: store)
        let endedAfterRelaunch = try await listening(relaunched, store: store)
        _ = try await signIn(relaunched)
        assertEnded(endedAfterRelaunch, .replaced, "the sign-in that replaced a stored session")
        XCTAssertEqual(endedAfterRelaunch.storedAtLast, .some(nil),
                       "the replaced stored session was reported once the new one was held")
        assertSilent(ended, "one service's listener heard another service's session end")
    }

    /// A rotated grant the Keychain cannot keep ends the session, as `.other`: the old grant is spent.
    func testTheHookFiresOnceForARotatedGrantTheKeychainCannotKeep() async throws {
        let store = RefusesRotationStore()
        let rotated = StoredGrant(issuer: Self.issuer, archive: Data("rotated-grant".utf8))
        let backend = GatedBackend(store: InMemoryTokenStore(),
                                   refresh: .success(FreshToken(accessToken: "fresh", grant: rotated)))
        try await bounded("opening the refresh gate") { await backend.open() }
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        await refreshRefused(service, "the refresh whose rotated grant cannot be kept")
        assertEnded(ended, .other, "the dropped rotation")
        XCTAssertNil(try store.load())
    }

    /// A stored copy `restore()` cannot use is wiped, and its session ends with it, once, as
    /// `.unusableStoredCopy`; the session signed in next has another identity.
    func testTheHookFiresOnceForAStoredCopyThatCannotBeRestored() async throws {
        let store = InMemoryTokenStore()
        try store.save(Data("not an envelope".utf8))
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        let restored = try await bounded("the restore") { await service.restore() }
        XCTAssertNil(restored)
        let unusable = assertEnded(ended, .unusableStoredCopy, "the unusable stored copy")
        let again = try await bounded("the second restore") { await service.restore() }
        XCTAssertNil(again)
        assertSilent(ended, "a restore with nothing stored reported an ended session")
        _ = try await signIn(service)
        let next = try await heldSession(service)
        XCTAssertNotEqual(next, unusable?.session, "the next session carries the unusable copy's identity")
    }

    /// A wipe that fails still ends the session, and says so once: the retries that follow (the next restore,
    /// the next sign-in) wipe again but end nothing new.
    func testAFailedWipeEndsTheSessionOnceAndItsRetriesEndNothing() async throws {
        let store = UndeletableStore()
        let backend = GatedBackend(store: InMemoryTokenStore(), refresh: .failure(.unavailable))
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        do {
            try await bounded("the sign-out") { try await service.signOut() }
            XCTFail("a sign-out whose wipe failed reported a clean one")
        } catch { XCTAssertEqual(error as? SessionNotWiped, SessionNotWiped()) }
        assertEnded(ended, .explicitSignOut, "the sign-out whose wipe failed")
        let restored = try await bounded("the restore") { await service.restore() }
        XCTAssertNil(restored, "a session that ended was restored")
        assertSilent(ended, "retrying the failed wipe by restoring reported the session again")
        // The sign-in drops the leftover copy before the browser opens: a wipe again, not a new end.
        let again = try await signIn(service)
        XCTAssertEqual(again, Session(issuer: Self.issuer, realm: "acme-sa"))
        assertSilent(ended, "the sign-in over the leftover copy reported the session again")
    }

    /// Nothing held, nothing reported: a sign-out, a restore and a session end before any sign-in, and a
    /// sign-in whose own grant the Keychain refused.
    func testTheHookIsSilentWhenNoSessionEnded() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable))
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        try await signOut(service)
        let restored = try await bounded("the restore") { await service.restore() }
        XCTAssertNil(restored)
        // The generation now: that sign-out's wipe moved it to 1, so this end passes the fence and wipes with
        // nothing held.
        try await bounded("a session end with nothing signed in") { try await service.endSessionLocally(servedBy: 1) }
        assertSilent(ended, "a call that ended nothing reported an ended session")

        let refusing = try self.service(GatedBackend(store: store, refresh: .failure(.unavailable)),
                                        store: RefusesSaveStore())
        let refusedEnds = try await listening(refusing)
        let issuer = Self.issuer
        do {
            let session = try await bounded("the sign-in") { try await refusing.signIn(issuer: issuer) }
            XCTFail("a sign-in the Keychain refused returned \(session)")
        } catch { XCTAssertEqual(error as? SignInFailure, .storage) }
        assertSilent(refusedEnds, "a sign-in that never held a session reported one ended")
    }

    /// The fence: Core's second 401 for a token an earlier session served, after a sign-out and a new
    /// sign-in, is a no-op, and reports nothing.
    func testTheHookIsSilentForAStaleSecondRefusal() async throws {
        let store = InMemoryTokenStore()
        let backend = try await servingBackend(store)
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        let served = try await bounded("the refresh") { try await service.accessToken(forceRefresh: true) }
        let stale = served.session
        try await signOut(service)
        _ = try await signIn(service)
        assertEnded(ended, .explicitSignOut, session: stale, "the sign-out")

        try await bounded("the stale 401") { try await service.endSessionLocally(servedBy: stale) }
        assertSilent(ended, "a stale 401 the fence turned away reported an ended session")
        try assertStoreHolds(store, "grant-2", "the stale 401 wiped the session that replaced its own")
    }

    /// The fence: a refusal that lands after a sign-out and a new sign-in is a no-op, and reports nothing.
    func testTheHookIsSilentForALateRefusal() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.refused))
        let service = try service(backend, store: store)
        let ended = try await listening(service)
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)
        try await signOut(service)
        _ = try await signIn(service)
        assertEnded(ended, .explicitSignOut, "the sign-out")

        try await bounded("opening the refresh gate") { await backend.open() }
        do {
            let token = try await bounded("the late refusal") { try await pending.value }
            XCTFail("a token from a refused refresh: \(token.value)")
        } catch { XCTAssertEqual(error as? AccessTokenFailure, .signedOut) }
        assertSilent(ended, "a late refusal the fence turned away reported an ended session")
        try assertStoreHolds(store, "grant-2", "the late refusal wiped the session that replaced its own")
    }

    /// The fence: a sign-out that a new sign-in overtook ends nothing when it wakes. The sign-in ended the
    /// session, once, and as the member's sign-out, since it revoked the grant that sign-out was to end.
    func testTheHookIsSilentForAnOvertakenSignOut() async throws {
        let store = InMemoryTokenStore()
        let backend = GatedBackend(store: store, refresh: .failure(.unavailable))
        let service = try service(backend, store: store, signOutWait: .seconds(30))
        let ended = try await listening(service)
        _ = try await signIn(service)
        let pending = Task { try await service.accessToken(forceRefresh: true) }
        await waitUntilRefreshing(backend)
        let signingOut = Task { try await service.signOut() }
        let queued = await signOutQueues(service)
        XCTAssertTrue(queued, "sign-out did not wait for the refresh in flight")

        _ = try await signIn(service)
        assertEnded(ended, .explicitSignOut, "the sign-in that took the sign-out over")
        try await bounded("opening the refresh gate") { await backend.open() }
        _ = try? await bounded("the refresh") { try await pending.value }
        try await bounded("the overtaken sign-out") { try await signingOut.value }
        assertSilent(ended, "the overtaken sign-out reported the session a second time")
        try assertStoreHolds(store, "grant-2", "the overtaken sign-out wiped the new session")
    }
}

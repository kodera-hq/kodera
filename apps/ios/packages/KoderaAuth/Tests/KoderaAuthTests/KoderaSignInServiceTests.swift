import Foundation
import XCTest
import KoderaClient
import KoderaDomain
@testable import KoderaAuth

/// A scripted backend: no browser, no network.
private actor FakeBackend: AuthorizationBackend {
    /// Authorization and revocation, in the order the service asked for them.
    enum Call: Equatable, Sendable {
        case authorize
        case revoke(StoredGrant)
    }

    var authorizeResult: Result<StoredGrant, BackendFailure>
    var refreshResults: [Result<FreshToken, BackendFailure>] = []
    private(set) var authorized: [AdmittedIssuer] = []
    private(set) var refreshes: [(StoredGrant, Bool)] = []
    private(set) var revoked: [StoredGrant] = []
    private(set) var calls: [Call] = []
    /// What the observed store held each time the browser opened; recorded only when a store is observed.
    private(set) var storeAtAuthorize: [Data?] = []
    private let observed: (any TokenStore)?

    init(authorize: Result<StoredGrant, BackendFailure>, observing store: (any TokenStore)? = nil) {
        authorizeResult = authorize
        observed = store
    }

    func script(refresh: [Result<FreshToken, BackendFailure>]) { refreshResults = refresh }
    func script(authorize: Result<StoredGrant, BackendFailure>) { authorizeResult = authorize }

    func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure)
        -> StoredGrant {
        authorized.append(issuer)
        calls.append(.authorize)
        if let observed { storeAtAuthorize.append(try? observed.load()) }
        return try authorizeResult.get()
    }

    func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken {
        refreshes.append((grant, forceRefresh))
        guard !refreshResults.isEmpty else { throw .protocolViolation }
        return try refreshResults.removeFirst().get()
    }

    func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async {
        revoked.append(grant)
        calls.append(.revoke(grant))
    }
}

private final class FailingStore: TokenStore, @unchecked Sendable {
    func load() throws(TokenStoreFailure) -> Data? { throw .keychain(-25_300) }
    func save(_ data: Data) throws(TokenStoreFailure) { throw .keychain(-34_018) }
    func wipe() throws(TokenStoreFailure) {}
}

/// Keeps what it is given and cannot delete it, like a Keychain item a failed delete left behind.
private final class StuckStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private(set) var wipes = 0
    func load() throws(TokenStoreFailure) -> Data? { lock.withLock { data } }
    func save(_ data: Data) throws(TokenStoreFailure) { lock.withLock { self.data = data } }
    func wipe() throws(TokenStoreFailure) {
        lock.withLock { wipes += 1 }
        throw .keychain(-25_244)
    }
}

/// Holds a session it cannot delete.
private final class UndeletableStore: TokenStore, @unchecked Sendable {
    func load() throws(TokenStoreFailure) -> Data? { Data("left by a previous install".utf8) }
    func save(_ data: Data) throws(TokenStoreFailure) {}
    func wipe() throws(TokenStoreFailure) { throw .keychain(-25_244) }
}

final class KoderaSignInServiceTests: XCTestCase {
    private static let issuer = "https://auth.kodera.test/realms/acme-sa"
    private static let grant = StoredGrant(issuer: issuer, archive: Data("grant-1".utf8))
    private static let rotated = StoredGrant(issuer: issuer, archive: Data("grant-2".utf8))

    private func configuration(loopback: LoopbackPolicy = .refuse,
                               origins: Set<String> = ["https://auth.kodera.test"]) throws -> SignInConfiguration {
        try SignInConfiguration(clientID: "kodera-ios", admittedIssuerOrigins: origins, loopback: loopback)
    }

    private func signedIn(_ backend: FakeBackend, store: InMemoryTokenStore = InMemoryTokenStore())
        async throws -> KoderaSignInService {
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        let session = try await service.signIn(issuer: Self.issuer)
        XCTAssertEqual(session, Session(issuer: Self.issuer, realm: "acme-sa"))
        return service
    }

    // MARK: trust

    func testUntrustedIssuerNeverReachesTheBackend() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        for issuer in ["https://evil.test/realms/acme-sa", "https://auth.kodera.test:8443/realms/acme-sa",
                       "http://auth.kodera.test/realms/acme-sa", "https://auth.kodera.test/realms/acme-sa/x"] {
            do {
                _ = try await service.signIn(issuer: issuer)
                XCTFail(issuer)
            } catch { XCTAssertEqual(error, .untrustedIssuer, issuer) }
        }
        let authorized = await backend.authorized
        XCTAssertTrue(authorized.isEmpty)
        XCTAssertNil(try store.load())
    }

    func testLoopbackIssuerNeedsTheDevelopmentPolicy() async throws {
        XCTAssertThrowsError(try configuration(loopback: .refuse, origins: ["http://localhost:8080"])) {
            XCTAssertEqual($0 as? SignInFailure, .notConfigured)
        }
        let backend = FakeBackend(authorize: .success(
            StoredGrant(issuer: "http://localhost:8080/realms/kodera-dev", archive: Data("g".utf8))))
        let service = KoderaSignInService(
            configuration: try configuration(loopback: .admitForDevelopment, origins: ["http://localhost:8080"]),
            store: InMemoryTokenStore(), backend: backend)
        let session = try await service.signIn(issuer: "http://localhost:8080/realms/kodera-dev")
        XCTAssertEqual(session.realm, "kodera-dev")
    }

    func testOfflineAccessIsRequestedOnlyWhenTheBuildEnablesIt() throws {
        XCTAssertEqual(try configuration().scopes, ["openid"], "off by default")
        let offline = try SignInConfiguration(clientID: "kodera-ios", admittedIssuerOrigins: ["https://auth.kodera.test"],
                                              loopback: .refuse, offlineAccess: true)
        XCTAssertEqual(offline.scopes, ["openid", "offline_access"])
    }

    func testConfigurationRefusesAnEmptyOrUnprintableClient() {
        for client in ["", "kodera ios", "kodera-ios\n", String(repeating: "a", count: 129)] {
            XCTAssertThrowsError(try SignInConfiguration(clientID: client,
                admittedIssuerOrigins: ["https://auth.kodera.test"], loopback: .refuse), client)
        }
        XCTAssertThrowsError(try SignInConfiguration(clientID: "kodera-ios", admittedIssuerOrigins: [], loopback: .refuse))
    }

    // MARK: sign-in and persistence

    func testSignInPersistsAndRestoresAcrossLaunches() async throws {
        let store = InMemoryTokenStore()
        _ = try await signedIn(FakeBackend(authorize: .success(Self.grant)), store: store)
        XCTAssertNotNil(try store.load())
        let relaunched = KoderaSignInService(configuration: try configuration(), store: store,
            backend: FakeBackend(authorize: .failure(.unavailable)))
        let restored = await relaunched.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))
    }

    func testBackendFailuresMapToSafeOutcomesAndPersistNothing() async throws {
        for (failure, expected) in [(BackendFailure.cancelled, SignInFailure.cancelled),
                                    (.unavailable, .identityUnavailable), (.refused, .refused),
                                    (.protocolViolation, .refused)] {
            let store = InMemoryTokenStore()
            let service = KoderaSignInService(configuration: try configuration(), store: store,
                backend: FakeBackend(authorize: .failure(failure)))
            do {
                _ = try await service.signIn(issuer: Self.issuer)
                XCTFail("\(failure)")
            } catch { XCTAssertEqual(error, expected) }
            XCTAssertNil(try store.load())
        }
    }

    /// Only an explicit sign-out revokes: Keycloak's revocation ends the member's sessions for this client
    /// on every device. A grant for another issuer is dropped with the refusal.
    func testGrantForAnotherIssuerIsRefusedAndNotRevoked() async throws {
        let other = StoredGrant(issuer: "https://auth.kodera.test/realms/other-org", archive: Data("g".utf8))
        let backend = FakeBackend(authorize: .success(other))
        let store = InMemoryTokenStore()
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        do { _ = try await service.signIn(issuer: Self.issuer); XCTFail() }
        catch { XCTAssertEqual(error, .refused) }
        XCTAssertNil(try store.load())
        let calls = await backend.calls
        XCTAssertEqual(calls, [.authorize], "dropped, never revoked")
    }

    /// A grant a new sign-in replaces is wiped before the browser opens, and never revoked: revoking it
    /// would end the member's sessions for this client on every device, the new one included.
    func testASignInThatReplacesAGrantDropsTheOldOneWithoutRevoking() async throws {
        let store = InMemoryTokenStore()
        let backend = FakeBackend(authorize: .success(Self.grant), observing: store)
        let service = try await signedIn(backend, store: store)
        XCTAssertNotNil(try store.load())
        await backend.script(authorize: .success(Self.rotated))
        _ = try await service.signIn(issuer: Self.issuer)
        let calls = await backend.calls
        XCTAssertEqual(calls, [.authorize, .authorize], "a sign-in revoked something")
        let atAuthorize = await backend.storeAtAuthorize
        XCTAssertEqual(atAuthorize, [nil, nil], "the browser opened while the Keychain still held the old grant")
        let stored = try XCTUnwrap(try store.load())
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Self.rotated.archive.base64EncodedString()))
        let restored = await service.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))
    }

    /// A stored copy a failed wipe left is dropped by the next sign-in, not revoked again: the one
    /// revocation is the explicit sign-out's.
    func testASignInDropsTheCopyAFailedWipeLeftWithoutRevoking() async throws {
        let store = StuckStore()
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        _ = try await service.signIn(issuer: Self.issuer)
        do { try await service.signOut(); XCTFail("the wipe failed") } catch {}
        await backend.script(authorize: .success(Self.rotated))
        _ = try await service.signIn(issuer: Self.issuer)
        let calls = await backend.calls
        XCTAssertEqual(calls, [.authorize, .revoke(Self.grant), .authorize], "only the sign-out revokes")
        let restored = await service.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))
    }

    /// The held grant is dropped before the browser opens, so a sign-in that fails afterwards leaves
    /// nothing: the old grant is not brought back, and nothing is revoked.
    func testASignInThatFailsAfterDroppingTheHeldGrantLeavesNothing() async throws {
        for failure in [BackendFailure.cancelled, .unavailable, .refused, .protocolViolation] {
            let store = InMemoryTokenStore()
            let backend = FakeBackend(authorize: .success(Self.grant))
            let service = try await signedIn(backend, store: store)
            await backend.script(authorize: .failure(failure))
            do {
                let session = try await service.signIn(issuer: Self.issuer)
                XCTFail("\(failure) signed in: \(session)")
            } catch {}
            let calls = await backend.calls
            XCTAssertEqual(calls, [.authorize, .authorize], "\(failure)")
            XCTAssertNil(try store.load(), "\(failure): the dropped grant was kept")
            let restored = await service.restore()
            XCTAssertNil(restored, "\(failure): the dropped grant was restored")
            do {
                let token = try await service.freshAccessToken()
                XCTFail("\(failure): a token from the dropped grant: \(token)")
            } catch { XCTAssertEqual(error, .signedOut, "\(failure)") }
        }
    }

    func testUnwritableKeychainKeepsNothingAndRevokesNothing() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = KoderaSignInService(configuration: try configuration(), store: FailingStore(), backend: backend)
        do { _ = try await service.signIn(issuer: Self.issuer); XCTFail() }
        catch { XCTAssertEqual(error, .storage) }
        let revoked = await backend.revoked
        XCTAssertTrue(revoked.isEmpty, "dropped, never revoked")
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
    }

    func testCorruptOrNoLongerAdmittedStateIsWipedOnRestore() async throws {
        let corrupt = InMemoryTokenStore(Data("not json".utf8))
        let first = KoderaSignInService(configuration: try configuration(), store: corrupt,
            backend: FakeBackend(authorize: .failure(.unavailable)))
        let none = await first.restore()
        XCTAssertNil(none)
        XCTAssertNil(try corrupt.load())

        let store = InMemoryTokenStore()
        _ = try await signedIn(FakeBackend(authorize: .success(Self.grant)), store: store)
        let narrowed = KoderaSignInService(
            configuration: try configuration(origins: ["https://other-auth.kodera.test"]), store: store,
            backend: FakeBackend(authorize: .failure(.unavailable)))
        let restored = await narrowed.restore()
        XCTAssertNil(restored)
        XCTAssertNil(try store.load())
    }

    // MARK: tokens

    func testFreshTokenPersistsARotatedGrant() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        await backend.script(refresh: [.success(FreshToken(accessToken: "access-2", grant: Self.rotated)),
                                       .success(FreshToken(accessToken: "access-3", grant: Self.rotated))])
        let first = try await service.freshAccessToken()
        XCTAssertEqual(first, "access-2")
        let forced = try await service.accessToken(forceRefresh: true)
        XCTAssertEqual(forced.value, "access-3")
        let refreshes = await backend.refreshes
        XCTAssertEqual(refreshes.map(\.1), [false, true])
        XCTAssertEqual(refreshes.last?.0, Self.rotated, "the rotated grant is the one used next")
        let stored = try XCTUnwrap(try store.load())
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Self.rotated.archive.base64EncodedString()))
    }

    func testRefusedRefreshSignsOutAndWipes() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        await backend.script(refresh: [.failure(.refused)])
        do { _ = try await service.accessToken(forceRefresh: true); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
        XCTAssertNil(try store.load())
        let restored = await service.restore()
        XCTAssertNil(restored)
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
        let refreshes = await backend.refreshes
        XCTAssertEqual(refreshes.count, 1, "no grant left to refresh")
        let revoked = await backend.revoked
        XCTAssertTrue(revoked.isEmpty, "a refused refresh drops the grant, never revokes it")
    }

    func testUnreachableProviderKeepsTheSession() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        await backend.script(refresh: [.failure(.unavailable)])
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .unavailable) }
        XCTAssertNotNil(try store.load())
        let restored = await service.restore()
        XCTAssertNotNil(restored)
    }

    func testConcurrentRefreshesRunOneAtATime() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = try await signedIn(backend)
        await backend.script(refresh: [.success(FreshToken(accessToken: "a", grant: Self.rotated)),
                                       .success(FreshToken(accessToken: "b", grant: Self.rotated))])
        async let one = service.accessToken(forceRefresh: true)
        async let two = service.accessToken(forceRefresh: true)
        let tokens = try await [one, two]
        XCTAssertEqual(Set(tokens.map(\.value)), ["a", "b"])
        let refreshes = await backend.refreshes
        // The second refresh starts from the grant the first one rotated to.
        XCTAssertEqual(refreshes.map(\.0), [Self.grant, Self.rotated])
    }

    // MARK: launch

    private func storedSession() async throws -> InMemoryTokenStore {
        let store = InMemoryTokenStore()
        _ = try await signedIn(FakeBackend(authorize: .success(Self.grant)), store: store)
        return store
    }

    func testResumeRefreshesSilentlyOnLaunch() async throws {
        let store = try await storedSession()
        let backend = FakeBackend(authorize: .failure(.unavailable))
        await backend.script(refresh: [.success(FreshToken(accessToken: "access-2", grant: Self.rotated))])
        let relaunched = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        let session = try await relaunched.resume()
        XCTAssertEqual(session, Session(issuer: Self.issuer, realm: "acme-sa"))
        let refreshes = await backend.refreshes
        XCTAssertEqual(refreshes.map(\.1), [true], "one forced refresh")
        XCTAssertEqual(refreshes.first?.0, Self.grant)
        let stored = try XCTUnwrap(try store.load())
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Self.rotated.archive.base64EncodedString()))
    }

    func testResumeAfterARefusedRefreshPurgesAndReturnsToSignIn() async throws {
        let store = try await storedSession()
        let backend = FakeBackend(authorize: .failure(.unavailable))
        await backend.script(refresh: [.failure(.refused)])
        let relaunched = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        let session = try await relaunched.resume()
        XCTAssertNil(session, "revoked, removed or expired: back to sign-in")
        XCTAssertNil(try store.load())
        let restored = await relaunched.restore()
        XCTAssertNil(restored)
    }

    func testResumeKeepsTheSessionWhenTheProviderIsUnreachable() async throws {
        let store = try await storedSession()
        let backend = FakeBackend(authorize: .failure(.unavailable))
        await backend.script(refresh: [.failure(.unavailable)])
        let relaunched = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        let session = try await relaunched.resume()
        XCTAssertEqual(session, Session(issuer: Self.issuer, realm: "acme-sa"))
        XCTAssertNotNil(try store.load())
    }

    func testResumeReportsARefusalWhoseWipeFailed() async throws {
        let store = StuckStore()
        let first = KoderaSignInService(configuration: try configuration(), store: store,
                                        backend: FakeBackend(authorize: .success(Self.grant)))
        _ = try await first.signIn(issuer: Self.issuer)
        let backend = FakeBackend(authorize: .failure(.unavailable))
        await backend.script(refresh: [.failure(.refused)])
        let relaunched = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        do {
            let session = try await relaunched.resume()
            XCTFail("a refusal whose wipe failed resumed \(String(describing: session))")
        } catch {
            XCTAssertEqual(error, SessionNotWiped())
        }
        let restored = await relaunched.restore()
        XCTAssertNil(restored, "the copy that could not be deleted is never brought back")
    }

    func testResumeWithNothingStoredAsksNothing() async throws {
        let backend = FakeBackend(authorize: .failure(.unavailable))
        let service = KoderaSignInService(configuration: try configuration(), store: InMemoryTokenStore(), backend: backend)
        let session = try await service.resume()
        XCTAssertNil(session)
        let refreshes = await backend.refreshes
        XCTAssertTrue(refreshes.isEmpty)
    }

    // MARK: reinstall

    private func scratchDefaults() throws -> (UserDefaults, String) {
        let name = "io.kodera.app.tests." + UUID().uuidString
        return (try XCTUnwrap(UserDefaults(suiteName: name)), name)
    }

    func testFirstLaunchAfterAnInstallWipesWhatAPreviousInstallLeft() throws {
        let (defaults, name) = try scratchDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let store = InMemoryTokenStore(Data("left by a previous install".utf8))
        try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        XCTAssertNil(try store.load())
        XCTAssertTrue(defaults.bool(forKey: FirstLaunch.markerKey))
        try store.save(Data("this install".utf8))
        try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        XCTAssertEqual(try store.load(), Data("this install".utf8), "a relaunch keeps the session")
    }

    func testAFailedWipeMakesTheNextLaunchWipeFirst() throws {
        let (defaults, name) = try scratchDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let store = InMemoryTokenStore()
        try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        try store.save(Data("ended, not deleted".utf8))
        FirstLaunch.requireWipe(defaults: defaults)
        try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        XCTAssertNil(try store.load())
        XCTAssertTrue(defaults.bool(forKey: FirstLaunch.markerKey))
    }

    func testAFailedFirstLaunchWipeIsReportedAndRetried() throws {
        let (defaults, name) = try scratchDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertThrowsError(try FirstLaunch.wipeIfNewInstall(store: UndeletableStore(), defaults: defaults)) {
            XCTAssertEqual($0 as? TokenStoreFailure, .keychain(-25_244))
        }
        XCTAssertFalse(defaults.bool(forKey: FirstLaunch.markerKey), "the next launch tries again")
    }

    // MARK: sign-out

    func testSignOutWipesThenRevokes() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        try await service.signOut()
        XCTAssertNil(try store.load())
        let revoked = await backend.revoked
        XCTAssertEqual(revoked, [Self.grant])
        let restored = await service.restore()
        XCTAssertNil(restored)
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
        try await service.signOut()
        let revokedAgain = await backend.revoked
        XCTAssertEqual(revokedAgain.count, 1, "nothing left to revoke")
    }

    func testMeClientSignOutGoesThroughTheService() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        let provider: any AccessTokenProvider = service
        try await provider.signOut()
        XCTAssertNil(try store.load())
        let revoked = await backend.revoked
        XCTAssertEqual(revoked, [Self.grant], "the explicit sign-out still revokes")
    }

    /// Core's second 401 ends the session on this device only: wiped, never revoked, so the member's
    /// other devices keep their sessions.
    func testCoresSecondRefusalEndsTheSessionLocallyWithoutRevoking() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        let provider: any AccessTokenProvider = service
        await backend.script(refresh: [.success(FreshToken(accessToken: "access-2", grant: Self.grant))])
        let served = try await provider.accessToken(forceRefresh: true)
        try await provider.endSessionLocally(servedBy: served.session)
        XCTAssertNil(try store.load())
        let restored = await service.restore()
        XCTAssertNil(restored)
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
        let calls = await backend.calls
        XCTAssertEqual(calls, [.authorize], "a local end revoked something")

        let stuck = StuckStore()
        let kept = KoderaSignInService(configuration: try configuration(), store: stuck, backend: backend)
        _ = try await kept.signIn(issuer: Self.issuer)
        await backend.script(refresh: [.success(FreshToken(accessToken: "access-3", grant: Self.grant))])
        let keptToken = try await kept.accessToken(forceRefresh: true)
        do {
            try await kept.endSessionLocally(servedBy: keptToken.session)
            XCTFail("a failed wipe reported as a clean end")
        } catch { XCTAssertEqual(error, SessionNotWiped()) }
        let restoredStuck = await kept.restore()
        XCTAssertNil(restoredStuck, "the copy that could not be deleted is never brought back")
        let revoked = await backend.revoked
        XCTAssertTrue(revoked.isEmpty)
    }

    /// Core's second 401 can arrive after the session that served its token ended and a new one began
    /// (a sign-out, then a sign-in). It belongs to the old session, and leaves the new one alone; a 401
    /// for a token the current session served still ends it.
    func testAStaleSecondRefusalLeavesTheSessionThatReplacedItAlone() async throws {
        let backend = FakeBackend(authorize: .success(Self.grant))
        let store = InMemoryTokenStore()
        let service = try await signedIn(backend, store: store)
        await backend.script(refresh: [.success(FreshToken(accessToken: "access-old", grant: Self.grant))])
        let stale = try await service.accessToken(forceRefresh: true)
        try await service.signOut()
        await backend.script(authorize: .success(Self.rotated))
        _ = try await service.signIn(issuer: Self.issuer)

        try await service.endSessionLocally(servedBy: stale.session)
        let stored = try XCTUnwrap(try store.load(), "a stale refusal wiped the session that replaced it")
        XCTAssertTrue(String(decoding: stored, as: UTF8.self).contains(Self.rotated.archive.base64EncodedString()))
        let restored = await service.restore()
        XCTAssertEqual(restored, Session(issuer: Self.issuer, realm: "acme-sa"))

        await backend.script(refresh: [.success(FreshToken(accessToken: "access-new", grant: Self.rotated))])
        let current = try await service.accessToken(forceRefresh: true)
        XCTAssertNotEqual(current.session, stale.session)
        try await service.endSessionLocally(servedBy: current.session)
        XCTAssertNil(try store.load(), "a refusal for the current session's own token did not end it")
        let calls = await backend.calls
        XCTAssertEqual(calls, [.authorize, .revoke(Self.grant), .authorize], "only the sign-out revokes")
    }

    /// A sign-in drops the grant it replaces before the browser opens. When that wipe fails and the
    /// sign-in then fails too, nothing overwrote the old copy, so the sign-in says so: the app then makes
    /// the next launch wipe it rather than restore an abandoned session.
    func testASignInThatCannotDeleteTheGrantItReplacedReportsIt() async throws {
        for failure in [BackendFailure.cancelled, .unavailable, .refused] {
            let store = StuckStore()
            let backend = FakeBackend(authorize: .success(Self.grant))
            let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
            _ = try await service.signIn(issuer: Self.issuer)
            await backend.script(authorize: .failure(failure))
            do {
                let session = try await service.signIn(issuer: Self.issuer)
                XCTFail("\(failure) signed in: \(session)")
            } catch {
                XCTAssertEqual(error, .sessionNotWiped, "\(failure): the abandoned copy went unreported")
            }
            XCTAssertNotNil(try store.load(), "\(failure): the store really kept it")
            let restored = await service.restore()
            XCTAssertNil(restored, "\(failure): the abandoned copy was restored")
            let revoked = await backend.revoked
            XCTAssertTrue(revoked.isEmpty, "\(failure): a replaced grant was revoked")
        }

        // The same failure with a Keychain that deletes is the failure itself: nothing was left behind.
        let store = InMemoryTokenStore()
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = try await signedIn(backend, store: store)
        await backend.script(authorize: .failure(.cancelled))
        do { _ = try await service.signIn(issuer: Self.issuer); XCTFail() }
        catch { XCTAssertEqual(error, .cancelled) }
    }

    /// A sign-out whose wipe fails says so. The session is over in memory, the provider is still asked to
    /// revoke, and the copy left behind is never restored.
    func testASignOutThatCannotWipeReportsIt() async throws {
        let store = StuckStore()
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        _ = try await service.signIn(issuer: Self.issuer)
        do {
            try await service.signOut()
            XCTFail("a failed wipe reported as a clean sign-out")
        } catch {
            XCTAssertEqual(error, SessionNotWiped())
        }
        XCTAssertNotNil(try store.load(), "the store really kept it")
        let revoked = await backend.revoked
        XCTAssertEqual(revoked, [Self.grant])
        let restored = await service.restore()
        XCTAssertNil(restored)
        do { _ = try await service.freshAccessToken(); XCTFail() }
        catch { XCTAssertEqual(error, .signedOut) }
        XCTAssertGreaterThanOrEqual(store.wipes, 2, "restore tried the wipe again")
    }

    func testARefusedRefreshThatCannotWipeReportsIt() async throws {
        let store = StuckStore()
        let backend = FakeBackend(authorize: .success(Self.grant))
        let service = KoderaSignInService(configuration: try configuration(), store: store, backend: backend)
        _ = try await service.signIn(issuer: Self.issuer)
        await backend.script(refresh: [.failure(.refused)])
        do { _ = try await service.accessToken(forceRefresh: true); XCTFail() }
        catch { XCTAssertEqual(error, .signedOutNotWiped) }
        let restored = await service.restore()
        XCTAssertNil(restored)
    }
}

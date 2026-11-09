import Foundation
import KoderaClient
import KoderaDomain

/// The one owner of the signed-in state: it admits the issuer, drives the backend, persists the grant
/// and wipes it when the provider refuses it.
///
/// Only an explicit sign-out revokes (`signOut()`, or the sign-in that overtakes one still waiting).
/// Keycloak's revocation endpoint answers a refresh or offline token by detaching this client from every
/// session the member has, on every device; when the revoked token is itself an offline token, it also
/// deletes the member's offline tokens for this client. Every other path that ends a session (a replaced
/// grant, a copy a failed wipe left, a grant for another issuer, an unwritable Keychain, a refused refresh,
/// Core's second 401) drops its tokens on this device only and never calls the revocation endpoint.
public actor KoderaSignInService: SignInService {
    private struct Envelope: Codable {
        let version: Int
        let issuer: String
        let state: Data
    }

    private struct Waiter {
        let id: UInt64
        let continuation: CheckedContinuation<Bool, Never>
    }

    private let configuration: SignInConfiguration
    private let store: any TokenStore
    private let backend: any AuthorizationBackend
    /// How long `signOut()` waits for a refresh in flight before it wipes anyway.
    private let signOutWait: Duration
    /// How long a sign-in waits for a sign-out's revocation still in flight before the browser opens anyway.
    private let revocationWait: Duration
    /// How long a sign-in waits for a sign-out's revocation still in flight. Longer than the revocation
    /// request's whole-exchange limit, so the browser never opens while that request is still live.
    public static let revocationWaitLimit: Duration = .seconds(15)
    private var grant: StoredGrant?
    private var admitted: AdmittedIssuer?
    /// Bumped on every sign-in and sign-out, so a refresh that finishes afterwards cannot resurrect state.
    private var generation: UInt64 = 0
    private var signingIn = false
    /// A wipe failed in this process: the stored copy belongs to an ended session and is never restored.
    private var unwiped = false
    // Refreshes run one at a time: Keycloak rotates refresh tokens, so two concurrent refreshes from the
    // same grant would see the second refused and sign the member out.
    private var refreshing = false
    private var waiters: [Waiter] = []
    private var nextWaiter: UInt64 = 0
    /// The generation the last sign-out set out to end. While it is still the current generation, that
    /// sign-out is waiting for a refresh in flight: whichever way a sign-out ends, it bumps the generation.
    private var signOutTarget: UInt64?
    /// The last revocation sent. A sign-in waits for it before the browser opens: Keycloak detaches this
    /// client from every session the member has, so a revocation landing after the new sign-in would end it.
    private var revocation: Task<Void, Never>?
    /// Told once for each session this service ends; see `addSessionEndedListener(_:)`.
    private var sessionEndedListeners: [@Sendable (SessionEnded) -> Void] = []

    public init(configuration: SignInConfiguration, store: any TokenStore, backend: any AuthorizationBackend,
                signOutWait: Duration = .seconds(5), revocationWait: Duration = KoderaSignInService.revocationWaitLimit) {
        self.configuration = configuration
        self.store = store
        self.backend = backend
        self.signOutWait = signOutWait
        self.revocationWait = revocationWait
    }

    /// `listener` is told once for each session this service ends, with the session's identity
    /// (`SessionEnded.session`, the `session` its access tokens carried) and the cause:
    /// - `.explicitSignOut`: `signOut()`, or a sign-in that took over a sign-out still waiting for a refresh;
    /// - `.refreshRefused`: the provider refused a refresh;
    /// - `.endedByServer`: Core's second 401 (`endSessionLocally(servedBy:)`);
    /// - `.replaced`: a sign-in replaced a held session (in memory, or a readable stored copy);
    /// - `.unusableStoredCopy`: `restore()` found a stored copy it cannot use;
    /// - `.other`: a rotated grant the Keychain could not keep.
    ///
    /// A call the generation fence turns away (a late refusal, a stale 401, a sign-out a new sign-in
    /// overtook) ends nothing and tells no one, and so does wiping again a copy whose earlier wipe failed in
    /// this process, by `restore()` or by a sign-in. Wipes outside this service (`FirstLaunch`) and a
    /// sign-in over a stored copy it cannot read are not reported either.
    ///
    /// It runs on this actor, synchronously, once the session's tokens are gone from memory and its stored
    /// copy has been wiped (or the wipe has failed), and before anything else runs on the service: a
    /// replaced session is reported before the sign-in that replaced it opens the browser. It must not
    /// block, and work it starts runs in a `Task` of its own. Features that keep data derived from the
    /// session (A2's Matrix session and store) end it here. Listeners are never removed; the service lives
    /// as long as the process.
    public func addSessionEndedListener(_ listener: @escaping @Sendable (SessionEnded) -> Void) {
        sessionEndedListeners.append(listener)
    }

    public func signIn(issuer: String) async throws(SignInFailure) -> Session {
        let admitted = try configuration.admit(issuer)
        guard !signingIn else { throw .inProgress }
        signingIn = true
        defer { signingIn = false }
        if let (held, heldIssuer) = dropHeld() { revoke(held, heldIssuer) }
        if let revocation {
            awaitingRevocation += 1
            await Self.awaitRevocation(revocation, within: revocationWait)
            awaitingRevocation -= 1
        }
        do throws(SignInFailure) { return try await authorizeAndKeep(admitted) }
        catch {
            // The copy of the grant this sign-in replaced could not be deleted, and no new grant overwrote
            // it: the caller must make the next launch wipe it before anything is restored.
            if unwiped, !wipeLocal(.replaced) { throw .sessionNotWiped }
            throw error
        }
    }

    private func authorizeAndKeep(_ admitted: AdmittedIssuer) async throws(SignInFailure) -> Session {
        let grant: StoredGrant
        do { grant = try await backend.authorize(issuer: admitted, configuration: configuration) }
        catch {
            switch error {
            case .cancelled: throw .cancelled
            case .unavailable: throw .identityUnavailable
            case .refused, .protocolViolation: throw .refused
            }
        }
        // A grant for another issuer is never kept, and never revoked: it is dropped with the refusal.
        guard grant.issuer == admitted.issuer else { throw .refused }
        generation &+= 1
        do { try persist(grant) }
        catch {
            // Nothing is kept on this device; the grant is dropped, not revoked. Nothing was held, so no
            // session ends here.
            wipeLocal(.other)
            throw .storage
        }
        self.grant = grant
        self.admitted = admitted
        unwiped = false // the stored copy is now this session's
        return Session(issuer: admitted.issuer, realm: admitted.realm)
    }

    /// A grant still held when a sign-in starts (in memory, or a readable stored copy a failed wipe left)
    /// is replaced by it, so it is wiped before the browser opens. Wiped before the browser, it is gone
    /// whatever the sign-in does next, so a sign-in that fails cannot bring it back.
    ///
    /// It is not revoked, since revoking it would end the member's sessions for this client on every
    /// device, the new one included, with one exception, which it returns: the grant an explicit sign-out
    /// still waiting for a refresh was to end. The sign-in revokes that one before the browser opens, when
    /// no new grant exists yet, so the member's sign-out is not lost to the sign-in that overtook it.
    private func dropHeld() -> (StoredGrant, AdmittedIssuer)? {
        guard let held = currentGrant() else { return nil }
        // A sign-out waits only behind a refresh, which holds a grant in memory, so the grant returned here
        // is that sign-out's and never a leftover stored copy.
        let signedOut = signOutTarget == generation
        // Also bumps the generation, so a refresh of the held grant still in flight is dropped, and the
        // waiting sign-out finds nothing of its own left to end. A stored copy is a session too, unless it
        // is the leftover of a wipe that failed in this process: that session's end was reported already.
        // A grant a waiting sign-out was to end ends as that sign-out: the sign-in revokes it.
        wipeLocal(signedOut ? .explicitSignOut : .replaced, endingStoredCopy: !unwiped)
        return signedOut ? held : nil
    }

    /// The grant in memory, else a readable stored copy for an issuer this build admits.
    private func currentGrant() -> (StoredGrant, AdmittedIssuer)? {
        if let grant, let admitted { return (grant, admitted) }
        guard let data = try? store.load(),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.version == 1,
              let admitted = try? configuration.admit(envelope.issuer) else { return nil }
        return (StoredGrant(issuer: envelope.issuer, archive: envelope.state), admitted)
    }

    public func restore() async -> Session? {
        if let admitted { return Session(issuer: admitted.issuer, realm: admitted.realm) }
        if unwiped {
            // Tried again; whatever happens, a session that ended is not brought back. Its end was reported.
            wipeLocal(.unusableStoredCopy)
            return nil
        }
        let data: Data?
        do { data = try store.load() } catch { return nil }
        guard let data else { return nil }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.version == 1,
              let admitted = try? configuration.admit(envelope.issuer) else {
            // Unreadable, or for an issuer this build no longer admits: never used, so wiped. If the wipe
            // fails, the copy is still refused here on every later launch. Its session ends here.
            wipeLocal(.unusableStoredCopy, endingStoredCopy: true)
            return nil
        }
        grant = StoredGrant(issuer: envelope.issuer, archive: envelope.state)
        self.admitted = admitted
        return Session(issuer: admitted.issuer, realm: admitted.realm)
    }

    public func resume() async throws(SessionNotWiped) -> Session? {
        guard let session = await restore() else { return nil }
        do {
            _ = try await accessToken(forceRefresh: true)
            return session
        } catch {
            switch error {
            case .signedOut: return nil
            case .signedOutNotWiped: throw SessionNotWiped()
            case .unavailable: return session
            }
        }
    }

    public func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        await acquire()
        defer { release() }
        guard let grant else { throw .signedOut }
        let started = generation
        let fresh: FreshToken
        do { fresh = try await backend.freshAccessToken(grant: grant, forceRefresh: forceRefresh) }
        catch {
            switch error {
            case .unavailable, .cancelled: throw .unavailable
            case .refused, .protocolViolation:
                if generation == started, !wipeLocal(.refreshRefused) { throw .signedOutNotWiped }
                throw .signedOut
            }
        }
        guard generation == started else { throw .signedOut }
        if fresh.grant != grant {
            do { try persist(fresh.grant) }
            catch {
                // The old grant is spent (rotation) and the new one could not be kept.
                throw wipeLocal(.other) ? AccessTokenFailure.signedOut : AccessTokenFailure.signedOutNotWiped
            }
            self.grant = fresh.grant
        }
        // A rotation does not bump the generation: the token is this session's, whatever grant it came from.
        return AccessToken(value: fresh.accessToken, session: started)
    }

    /// Core refused a freshly refreshed token: the session that served it ends on this device only. The
    /// stored copy is wiped and the provider is asked nothing, so the member's other devices keep their
    /// sessions. A refusal that arrives after that session ended (a sign-out, a new sign-in) does nothing:
    /// the session that replaced it is not this call's to end. Throws when the stored copy could not be deleted.
    public func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {
        guard session == generation else { return }
        guard wipeLocal(.endedByServer) else { throw SessionNotWiped() }
    }

    /// The explicit sign-out, and the only path that revokes: Keycloak then ends the member's sessions
    /// for this client on every device.
    /// Waits up to `signOutWait` for a refresh in flight, so the grant it revokes is the one that refresh
    /// rotated to; past that it wipes anyway, and the refresh's own generation check drops what it brings
    /// back. The Keychain is wiped before revocation: the session is gone locally even if the provider
    /// never answers. Throws when the stored copy could not be deleted.
    ///
    /// A sign-in that starts while this call waits takes the revocation over (see `dropHeld()`).
    public func signOut() async throws(SessionNotWiped) {
        let target = generation
        signOutTarget = target
        let held = await acquire(within: signOutWait)
        var revoking: Task<Void, Never>?
        var wiped = true
        // Fenced: a session that a refused refresh already ended is not this call's to end again, and one
        // a new sign-in replaced was revoked by that sign-in.
        if generation == target {
            let previous = grant.flatMap { grant in admitted.map { (grant, $0) } }
            wiped = wipeLocal(.explicitSignOut)
            if let (grant, issuer) = previous { revoking = revoke(grant, issuer) }
        }
        if held { release() }
        await revoking?.value
        guard wiped else { throw SessionNotWiped() }
    }

    /// The revocation's end or `limit`, whichever comes first. The revocation is not cancelled: past the limit
    /// it keeps running on its own bounded session, and one that lands after the browser opened can still end
    /// the new session, as on Android.
    private static func awaitRevocation(_ revocation: Task<Void, Never>, within limit: Duration) async {
        let latch = Latch()
        Task { await revocation.value; latch.open() }
        let deadline = Task { try? await Task.sleep(for: limit); latch.open() }
        await withCheckedContinuation { latch.set($0) }
        deadline.cancel()
    }

    /// Sends the revocation and keeps it, so the next sign-in waits for it before the browser opens.
    @discardableResult
    private func revoke(_ grant: StoredGrant, _ issuer: AdmittedIssuer) -> Task<Void, Never> {
        let task = Task { [backend, configuration] in
            await backend.revoke(grant: grant, issuer: issuer, configuration: configuration)
        }
        revocation = task
        return task
    }

    private func persist(_ grant: StoredGrant) throws {
        let data = try JSONEncoder().encode(Envelope(version: 1, issuer: grant.issuer, state: grant.archive))
        try store.save(data)
    }

    /// The in-memory session is gone whatever happens. False when the stored copy could not be deleted,
    /// which every caller reports.
    ///
    /// The session-ended listeners hear of it, with `cause` and the generation being ended, when a session
    /// is held in memory, or when the caller ends a stored copy (`endingStoredCopy`). A wipe with nothing
    /// held (a retry of a wipe that failed, a sign-in whose new grant the Keychain refused, a sign-out with
    /// nothing signed in) ends no session, whatever its `cause`.
    @discardableResult
    private func wipeLocal(_ cause: SessionEndCause, endingStoredCopy: Bool = false) -> Bool {
        let ending = endingStoredCopy || grant != nil || admitted != nil
        // The generation the ended session's tokens carry; bumped next, so no later session shares it.
        let ended = SessionEnded(session: generation, cause: cause)
        generation &+= 1
        grant = nil
        admitted = nil
        let wiped: Bool
        do {
            try store.wipe()
            wiped = true
        } catch {
            wiped = false
        }
        unwiped = !wiped
        if ending { sessionEnded(ended) }
        return wiped
    }

    private func sessionEnded(_ event: SessionEnded) {
        for listener in sessionEndedListeners { listener(event) }
    }

    // MARK: the refresh slot

    /// For tests: callers waiting for the refresh slot.
    var queuedForRefresh: Int { waiters.count }
    /// For tests: sign-ins waiting for a revocation before they open the browser.
    private(set) var awaitingRevocation = 0

    private func acquire() async {
        _ = await acquire(within: nil)
    }

    /// True once the caller holds the slot. With a limit, false when it elapsed first; the caller then
    /// does not hold the slot and must not release it.
    private func acquire(within limit: Duration?) async -> Bool {
        guard refreshing else {
            refreshing = true
            return true
        }
        nextWaiter &+= 1
        let id = nextWaiter
        if let limit {
            Task { [weak self] in
                try? await Task.sleep(for: limit)
                await self?.expire(id)
            }
        }
        return await withCheckedContinuation { waiters.append(Waiter(id: id, continuation: $0)) }
    }

    private func expire(_ id: UInt64) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(returning: false)
    }

    private func release() {
        if waiters.isEmpty { refreshing = false } else { waiters.removeFirst().continuation.resume(returning: true) }
    }
}

/// Resumes the one continuation it holds at the first `open()`, whether that comes before or after `set`.
private final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func set(_ continuation: CheckedContinuation<Void, Never>) {
        let now = lock.withLock { () -> Bool in
            if opened { return true }
            self.continuation = continuation
            return false
        }
        if now { continuation.resume() }
    }

    func open() {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard !opened else { return nil }
            opened = true
            let waiting = continuation
            continuation = nil
            return waiting
        }
        waiting?.resume()
    }
}

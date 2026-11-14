import SwiftUI
import UIKit
import KoderaAuth
import KoderaClient
import KoderaDomain
import CryptoKit

/// Whether the member is signed in, and what Core says about them. Authentication tokens stay inside
/// the sign-in service and Keychain; foreground radio capabilities are volatile and epoch-bounded.
@MainActor
final class AppSessionModel: ObservableObject {
    enum Phase: Equatable {
        case restoring, signedOut, signingIn, signedIn(Session)
    }
    typealias Member = OrganisationChannelsLoader.Member

    @Published private(set) var phase: Phase = .restoring {
        // Leaving a session drops its Core clients, so nothing of it outlives it.
        didSet {
            guard case let .signedIn(session) = phase, core?.session == session else { core = nil; return }
        }
    }
    @Published private(set) var member: Member = .loading
    @Published private(set) var workspace: OrganisationChannelsLoader.Workspace = .hidden
    private let channels: OrganisationChannelsLoader
    /// Why the last attempt did not end signed in, as a catalogue key.
    @Published private(set) var noticeKey: String?

    let configuration: AppConfiguration
    private let service: (any SignInService)?
    private let store: any TokenStore
    private let defaults: UserDefaults
    typealias RequesterFactory = @MainActor (String, LoopbackPolicy, any SignInService) throws -> CoreRequester
    private let requesterFactory: RequesterFactory
    let proximityRadioSession = VoluntaryProximityRadioSession(
        gattDriver: CoreBluetoothGattRadioDriver(), bonjourDriver: NetworkBonjourProximityDriver()
    )
    @Published private(set) var isPreparingProximity = false
    @Published private(set) var proximityPreparationErrorKey: String?
    private var proximityTask: Task<Void, Never>?
    private var proximityAttempt = UUID()
    private var proximityScope: (organisation: String, workspace: String)?
    private var isForegroundActive = false
    /// Completion includes the coordinator reducer and synchronous App effects; actions remain Void.
    private(set) var signInTask: Task<Void, Never>?
    private(set) var signOutTask: Task<Void, Never>?
    /// The signed-in session's Core clients: one `CoreRequester`, bound to the configured Core origin and
    /// shared by every Core client of that session. Nil when signed out or when Core is not configured.
    private var core: CoreClients? {
        // A requester let go of, by leaving its session or by a replacement, is invalidated on the spot: a
        // client that still holds it sends nothing more, so no bearer outlives the session that owned it.
        didSet {
            if let left = oldValue?.requester, left !== core?.requester {
                left.invalidate()
                resetProximity()
            }
        }
    }

    private struct CoreClients: Sendable {
        let session: Session
        let requester: CoreRequester
        let me: CoreMeClient
        let workspace: CoreWorkspaceClient
    }

    convenience init(configuration: AppConfiguration) {
        let store = KeychainTokenStore()
        let service: KoderaSignInService?
        if let signIn = configuration.signIn {
            let backend = AppAuthBackend(presenter: { Self.presentingViewController() })
            service = KoderaSignInService(configuration: signIn, store: store, backend: backend)
        } else {
            service = nil
        }
        self.init(configuration: configuration, service: service, store: store, defaults: .standard,
                  channels: OrganisationChannelsLoader(), requesterFactory: { origin, policy, service in
            try CoreRequester(coreApiOrigin: origin, loopback: policy, tokens: service)
        })
    }

    /// Internal composition boundary: production and hosted tests share every state/effect mapping.
    init(configuration: AppConfiguration, service: (any SignInService)?, store: any TokenStore,
         defaults: UserDefaults, channels: OrganisationChannelsLoader,
         requesterFactory: @escaping RequesterFactory) {
        self.configuration = configuration
        self.service = service
        self.store = store
        self.defaults = defaults
        self.channels = channels
        self.requesterFactory = requesterFactory
        proximityRadioSession.onAuthenticatedRebootstrapRequired = { [weak self] deadline in
            self?.prepareProximity(renewUntil: deadline)
        }
        channels.onChange = { [weak self] state in
            self?.member = state.member
            self?.workspace = state.workspace
            if let self, let scope = self.proximityScope {
                guard case .loaded = state.member, case let .loaded(snapshot) = state.workspace,
                      snapshot.organisationId == scope.organisation, snapshot.id == scope.workspace else {
                    self.resetProximity()
                    return
                }
            }
        }
        channels.onEffect = { [weak self] effect in
            guard let self else { return }
            // Exhaustive synchronous mapping: ownership and monotonicity were decided by the coordinator.
            switch effect {
            case let .ended(explicit):
                phase = .signedOut
                noticeKey = explicit ? nil : "session.ended"
            case .requireWipe: sessionNotWiped()
            case .clearNotice: noticeKey = nil
            case .authenticationStopped: phase = .signedOut
            }
        }
    }

    var canSignIn: Bool { service != nil && phase == .signedOut && !channels.isAuthenticating }
    var canRetryChannels: Bool {
        guard case .loaded = member else { return false }
        return channels.canRetry
    }

    /// Launch: a reinstall's leftover Keychain item is wiped first, then the stored session is resumed
    /// with one silent refresh. A refused refresh has purged everything, and the member signs in again.
    func start() async {
        guard phase == .restoring else { return }
        guard let service else { phase = .signedOut; return }
        guard let context = channels.beginAuthentication() else { return }
        do throws(TokenStoreFailure) {
            try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        } catch {
            channels.completeAuthentication(context, failed: true) {
                phase = .signedOut
                noticeKey = "signin.storage"
            }
            return
        }
        let result: Result<Session?, SessionNotWiped>
        do throws(SessionNotWiped) { result = .success(try await service.resume()) }
        catch { result = .failure(error) }
        let failed: Bool
        if case .failure = result { failed = true } else { failed = false }
        channels.completeAuthentication(context, failed: failed, notWiped: failed) {
            switch result {
            case let .success(.some(session)): enter(session)
            case .success(.none): phase = .signedOut
            case .failure: break // The coordinator synchronously emitted the distinct wipe-required effect.
            }
        }
    }

    func signIn(issuer: String) {
        guard let service, phase == .signedOut, let context = channels.beginAuthentication() else { return }
        phase = .signingIn
        signInTask = Task {
            let result: Result<Session, SignInFailure>
            do throws(SignInFailure) { result = .success(try await service.signIn(issuer: issuer)) }
            catch { result = .failure(error) }
            let failed: Bool
            let notWiped: Bool
            switch result {
            case .success: failed = false; notWiped = false
            case .failure(.sessionNotWiped): failed = true; notWiped = true
            case .failure: failed = true; notWiped = false
            }
            channels.completeAuthentication(context, failed: failed, notWiped: notWiped) {
                switch result {
                case let .success(session): enter(session)
                case .failure(.sessionNotWiped): break // Already mapped through the coordinator's terminal reducer.
                case let .failure(failure):
                    guard let notice = Self.notice(for: failure) else { return }
                    phase = .signedOut
                    noticeKey = notice
                }
            }
        }
    }

    /// The catalogue key for a sign-in that did not end signed in; nil when there is nothing to say yet.
    private static func notice(for failure: SignInFailure) -> String? {
        switch failure {
        case .inProgress: nil
        case .cancelled: "signin.cancelled"
        case .untrustedIssuer: "signin.untrusted"
        case .identityUnavailable: "signin.unavailable"
        case .refused: "signin.refused"
        case .storage: "signin.storage"
        case .sessionNotWiped: "session.not_wiped"
        case .notConfigured: "login.unavailable"
        }
    }

    /// The session ended but its Keychain copy is still there: say so, and make the next launch wipe it
    /// before anything is restored.
    private func sessionNotWiped() {
        FirstLaunch.requireWipe(defaults: defaults)
        noticeKey = "session.not_wiped"
    }

    func reloadMember() { channels.retry() }
    func checkMemberAgain() { channels.checkAgain() }
    func retryChannels() { channels.retry() }
    func setForeground(_ active: Bool) {
        isForegroundActive = active
        proximityRadioSession.handleSceneForegroundChange(isActive: active)
        if !active { resetProximity() }
        channels.setForeground(active)
    }

    /// An explicit consent action obtains fresh current-member radio material; no automatic scan.
    func prepareProximity() {
        prepareProximity(renewUntil: nil)
    }

    private func prepareProximity(renewUntil: UInt64?) {
        guard isForegroundActive, case .signedIn = phase, case .loaded = member,
              case let .loaded(snapshot) = workspace, snapshot.state == .initialised,
              snapshot.setup.state == .ready, let workspaceId = snapshot.id, let clients = core else { return }
        if let renewUntil {
            guard renewUntil > ProximityBounds.currentUnixSeconds(),
                  proximityScope?.organisation == snapshot.organisationId, proximityScope?.workspace == workspaceId else { return }
        }
        resetProximity()
        let attempt = proximityAttempt
        proximityScope = (snapshot.organisationId, workspaceId)
        isPreparingProximity = true
        proximityTask = Task { [weak self] in
            do {
                let material = try await CoreProximityClient(requester: clients.requester).bootstrap(workspaceId: workspaceId)
                guard !Task.isCancelled, let self, self.proximityAttempt == attempt,
                      self.isForegroundActive, self.core?.requester === clients.requester,
                      case .signedIn = self.phase, case .loaded = self.member,
                      case let .loaded(current) = self.workspace,
                      current.organisationId == snapshot.organisationId, current.id == workspaceId else { return }
                let seed = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
                try self.proximityRadioSession.provisionEpoch(
                    organisationId: material.workspaceId, scopeTag: material.scopeTag,
                    epoch: material.epoch, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds,
                    epochMacKey: material.epochMacKey, deviceSeed: seed
                )
                try self.proximityRadioSession.grantForegroundConsent()
                if let renewUntil {
                    try self.proximityRadioSession.startVoluntarySession(consentExpiresAtUnixSeconds: renewUntil)
                }
                self.isPreparingProximity = false
                self.proximityTask = nil
            } catch {
                guard let self, self.proximityAttempt == attempt else { return }
                self.proximityRadioSession.clearProvisioning()
                self.isPreparingProximity = false
                self.proximityPreparationErrorKey = "proximity.voluntary_unavailable"
                self.proximityTask = nil
            }
        }
    }

    private func resetProximity() {
        proximityAttempt = UUID()
        proximityTask?.cancel()
        proximityTask = nil
        proximityScope = nil
        isPreparingProximity = false
        proximityPreparationErrorKey = nil
        proximityRadioSession.clearProvisioning()
    }

    func signOut() {
        guard let context = channels.beginSignOut(), let service else { return }
        let coordinator = channels
        signOutTask = Task {
            let notWiped: Bool
            do throws(SessionNotWiped) { try await service.signOut(); notWiped = false }
            catch { notWiped = true }
            // Forward even after phase/core changed: only the coordinator reduces this captured owner receipt.
            coordinator.completeSignOut(context, notWiped: notWiped)
        }
    }

    private func enter(_ session: Session) {
        let clients = coreClients(for: session)
        core = clients
        if let clients {
            channels.enter(realm: session.realm, requester: clients.requester,
                fetchMember: { await clients.me.fetch() },
                fetchWorkspace: { await clients.workspace.fetch(organisationId: $0) })
        } else {
            channels.enter(realm: session.realm, requester: nil)
        }
        phase = .signedIn(session)
        noticeKey = nil
    }

    /// One requester per accepted session, reused by both readers. No latest-only MemberLoader filter upstream.
    private func coreClients(for session: Session) -> CoreClients? {
        guard let service, let origin = configuration.coreApiOrigin,
              let requester = try? requesterFactory(origin, AppConfiguration.loopback, service) else { return nil }
        return CoreClients(session: session, requester: requester, me: CoreMeClient(requester: requester),
                           workspace: CoreWorkspaceClient(requester: requester))
    }

    /// The front-most view controller of the active window, for the browser sheet.
    private static func presentingViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let active = scenes.filter { $0.activationState == .foregroundActive }
        let window = (active.isEmpty ? scenes : active).flatMap(\.windows).first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

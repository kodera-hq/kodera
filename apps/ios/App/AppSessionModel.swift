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
    private let fetchWorkspace: (@Sendable (String) async -> WorkspaceOutcome)?
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
    private static let vaultDeviceIdDefaultsKey = "io.kodera.app.session.vault_device_id"
    private static let pushDeviceIdDefaultsKey = "io.kodera.app.session.push_device_id"
    private static let vaultUnwipedDefaultsKey = "io.kodera.app.session.vault_unwiped"

    private(set) var signInTask: Task<Void, Never>?
    private(set) var signOutTask: Task<Void, Never>?
    @Published private(set) var activeConversation: ChannelConversationModel?
    typealias ConversationTransportFactory = @MainActor (ChannelConversationScope, CoreRequester?) -> (any ChannelConversationTransport)?
    private let conversationTransportFactory: ConversationTransportFactory?
    private let matrixSsoAuthorizerFactory: (@MainActor (SessionFence) -> MatrixSsoAuthorizer)?
    private let matrixProtocolClass: URLProtocol.Type?
    private let sessionVault: KeychainSessionVault
    private var vaultUnwiped = false
    private var activeSessionFence = SessionFence()
    private var activeVaultOrganisationId: String?
    private var registeredPushDeviceId: String?
    private(set) var nativeCalls: NativeVoIPRuntime?
    private var activeMatrixTransport: MatrixChannelConversationTransport?
    private var activeMatrixSession: PersistedMatrixSession?
    /// The signed-in session's Core clients: one `CoreRequester`, bound to the configured Core origin and
    /// shared by every Core client of that session. Nil when signed out or when Core is not configured.
    private var core: CoreClients? {
        // A requester let go of, by leaving its session or by a replacement, is invalidated on the spot: a
        // client that still holds it sends nothing more, so no bearer outlives the session that owned it.
        didSet {
            if let left = oldValue?.requester, left !== core?.requester {
                left.invalidate()
                rotateSessionFence()
                resetProximity()
                closeChannel()
            }
        }
    }

    private struct CoreClients: Sendable {
        let session: Session
        let requester: CoreRequester
        let me: CoreMeClient
        let workspace: CoreWorkspaceClient
        let pushWakeup: PushWakeupCoordinator
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
        let ssoBackend = MatrixSsoAuthorizerBackend(presenter: { Self.presentingViewController() })
        self.init(configuration: configuration, service: service, store: store, defaults: .standard,
                  channels: OrganisationChannelsLoader(), requesterFactory: { origin, policy, service in
            try CoreRequester(coreApiOrigin: origin, loopback: policy, tokens: service)
        }, sessionVault: KeychainSessionVault(),
                  matrixSsoAuthorizerFactory: { fence in ssoBackend.makeAuthorizer(fence: fence) })
    }

    /// Internal composition boundary: production and hosted tests share every state/effect mapping.
    init(configuration: AppConfiguration, service: (any SignInService)?, store: any TokenStore,
         defaults: UserDefaults, channels: OrganisationChannelsLoader,
         requesterFactory: @escaping RequesterFactory,
         sessionVault: KeychainSessionVault = KeychainSessionVault(
             keyStore: InMemoryTokenStore(),
             sealedStore: InMemoryTokenStore()
         ),
         conversationTransportFactory: ConversationTransportFactory? = nil,
         matrixSsoAuthorizerFactory: (@MainActor (SessionFence) -> MatrixSsoAuthorizer)? = nil,
         matrixProtocolClass: URLProtocol.Type? = nil,
         fetchWorkspace: (@Sendable (String) async -> WorkspaceOutcome)? = nil) {
        self.configuration = configuration
        self.service = service
        self.store = store
        self.defaults = defaults
        self.channels = channels
        self.requesterFactory = requesterFactory
        self.fetchWorkspace = fetchWorkspace
        self.sessionVault = sessionVault
        self.conversationTransportFactory = conversationTransportFactory
        self.matrixSsoAuthorizerFactory = matrixSsoAuthorizerFactory
        self.matrixProtocolClass = matrixProtocolClass
        self.vaultUnwiped = defaults.bool(forKey: Self.vaultUnwipedDefaultsKey)
        proximityRadioSession.onAuthenticatedRebootstrapRequired = { [weak self] deadline in
            self?.prepareProximity(renewUntil: deadline)
        }
        channels.onChange = { [weak self] state in
            self?.member = state.member
            self?.workspace = state.workspace
            if let self, case let .loaded(snapshot) = state.workspace {
                if let previousOrg = self.activeVaultOrganisationId, previousOrg != snapshot.organisationId {
                    let retiringFence = self.rotateSessionFence()
                    self.closeChannel()
                    self.activeMatrixSession = nil
                    self.activeVaultOrganisationId = snapshot.organisationId
                    if !self.wipeSessionVaultAndDeviceIds(invalidating: retiringFence) {
                        self.channels.closeReads()
                        self.core = nil
                        self.phase = .signedOut
                        return
                    }
                } else {
                    self.activeVaultOrganisationId = snapshot.organisationId
                }
            }
            if let self, let conversation = self.activeConversation {
                if Self.conversationAuthorityLost(scope: conversation.scope, state: state) {
                    self.closeChannel()
                } else if case let .loaded(snapshot) = state.workspace {
                    let channels = snapshot.uncategorisedChannels + snapshot.categories.flatMap(\.channels)
                    if let channel = channels.first(where: { $0.id == conversation.scope.channelId }) {
                        conversation.updateChannelSecurity(isConfidential: channel.isConfidential)
                    }
                }
            }
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
                let retiringFence = self.rotateSessionFence()
                self.activeVaultOrganisationId = nil
                self.activeMatrixSession = nil
                self.closeChannel()
                let wiped = self.wipeSessionVaultAndDeviceIds(invalidating: retiringFence)
                self.phase = .signedOut
                self.noticeKey = wiped ? (explicit ? nil : "session.ended") : "session.not_wiped"
            case .requireWipe:
                let retiringFence = self.rotateSessionFence()
                self.activeVaultOrganisationId = nil
                self.activeMatrixSession = nil
                self.closeChannel()
                _ = self.wipeSessionVaultAndDeviceIds(invalidating: retiringFence)
                self.sessionNotWiped()
            case .clearNotice: noticeKey = nil
            case .authenticationStopped:
                _ = self.rotateSessionFence()
                self.closeChannel()
                self.phase = .signedOut
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
        let isNewInstall = !defaults.bool(forKey: FirstLaunch.markerKey)
        do throws(TokenStoreFailure) {
            try FirstLaunch.wipeIfNewInstall(store: store, defaults: defaults)
        } catch {
            channels.completeAuthentication(context, failed: true) {
                phase = .signedOut
                noticeKey = "signin.storage"
            }
            return
        }
        if vaultUnwiped || defaults.bool(forKey: Self.vaultUnwipedDefaultsKey) {
            defaults.removeObject(forKey: Self.vaultDeviceIdDefaultsKey)
            defaults.removeObject(forKey: Self.pushDeviceIdDefaultsKey)
            do {
                try sessionVault.wipe()
                vaultUnwiped = false
                defaults.removeObject(forKey: Self.vaultUnwipedDefaultsKey)
            } catch {
                vaultUnwiped = true
                defaults.set(true, forKey: Self.vaultUnwipedDefaultsKey)
                FirstLaunch.requireWipe(defaults: defaults)
                channels.completeAuthentication(context, failed: true, notWiped: true) {}
                return
            }
        } else if isNewInstall {
            defaults.removeObject(forKey: Self.vaultDeviceIdDefaultsKey)
            defaults.removeObject(forKey: Self.pushDeviceIdDefaultsKey)
            do {
                try sessionVault.wipe()
            } catch {
                FirstLaunch.requireWipe(defaults: defaults)
                channels.completeAuthentication(context, failed: true) {
                    phase = .signedOut
                    noticeKey = "signin.storage"
                }
                return
            }
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
        let hasUnwipedVault = vaultUnwiped || defaults.bool(forKey: Self.vaultUnwipedDefaultsKey)
        let hasTerminalNotWiped = channels.terminalStrength == .signedOutNotWiped || noticeKey == "session.not_wiped"
        if hasUnwipedVault || hasTerminalNotWiped {
            do {
                try sessionVault.wipe()
                vaultUnwiped = false
                defaults.removeObject(forKey: Self.vaultUnwipedDefaultsKey)
            } catch {
                vaultUnwiped = true
                defaults.set(true, forKey: Self.vaultUnwipedDefaultsKey)
                channels.completeAuthentication(context, failed: true, notWiped: true) {}
                return
            }
            if hasTerminalNotWiped {
                do {
                    try store.wipe()
                    defaults.set(true, forKey: FirstLaunch.markerKey)
                } catch {
                    channels.completeAuthentication(context, failed: true, notWiped: true) {}
                    return
                }
            }
        }
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
        activeConversation?.setForeground(active)
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
        guard !channels.isAuthenticating, case .signedIn = phase, let service else { return }
        let pushDeviceId = registeredPushDeviceId ?? defaults.string(forKey: Self.pushDeviceIdDefaultsKey)
        let matrixTransport = activeMatrixTransport
        var matrixSessionToLogout = activeMatrixSession
        if matrixSessionToLogout == nil,
           let orgId = activeVaultOrganisationId ?? channels.loadedOrganisation?.id,
           let vaultDeviceId = defaults.string(forKey: Self.vaultDeviceIdDefaultsKey),
           let rawVault = try? sessionVault.open(organisationId: orgId, deviceId: vaultDeviceId),
           let decoded = try? PersistedMatrixSession.decodeVaultData(rawVault) {
            matrixSessionToLogout = decoded
        }
        activeMatrixTransport = nil
        activeMatrixSession = nil
        activeVaultOrganisationId = nil
        let retiringFence = rotateSessionFence()
        closeChannel()
        let vaultWiped = wipeSessionVaultAndDeviceIds(invalidating: retiringFence)
        guard let context = channels.beginSignOut() else { return }
        let coordinator = channels
        let coreOrigin = configuration.coreApiOrigin
        let makeRequester = requesterFactory
        let protocolClass = matrixProtocolClass
        signOutTask = Task {
            if let pushDeviceId,
               let coreOrigin,
               let revokeRequester = try? makeRequester(coreOrigin, AppConfiguration.loopback, service) {
                try? await PushWakeupCoordinator(requester: revokeRequester).revokeOnSignOut(deviceId: pushDeviceId)
                revokeRequester.invalidate()
            }
            if let matrixTransport {
                await matrixTransport.logoutIfAuthenticated()
            } else if let session = matrixSessionToLogout {
                await MatrixRoomClient.logoutStandalone(
                    homeserverOrigin: session.homeserverOrigin,
                    matrixAccessToken: session.accessToken,
                    loopback: AppConfiguration.loopback,
                    protocolClass: protocolClass
                )
            }
            let serviceNotWiped: Bool
            do throws(SessionNotWiped) { try await service.signOut(); serviceNotWiped = false }
            catch { serviceNotWiped = true }
            // Forward even after phase/core changed: only the coordinator reduces this captured owner receipt.
            coordinator.completeSignOut(context, notWiped: serviceNotWiped || !vaultWiped)
        }
    }

    func registerPushWakeup(
        deviceId: String,
        endpoint: String,
        p256dh: String,
        auth: String
    ) async throws(PushWakeupFailure) {
        guard case .signedIn = phase, let clients = core else {
            throw .signedOut
        }
        try await clients.pushWakeup.registerDeviceWakeup(
            deviceId: deviceId,
            endpoint: endpoint,
            p256dh: p256dh,
            auth: auth
        )
        registeredPushDeviceId = deviceId
        defaults.set(deviceId, forKey: Self.pushDeviceIdDefaultsKey)
    }

    func handleIncomingPushWakeup(rawPayload: Data) async throws(PushWakeupFailure) -> InboxNotificationPage {
        guard case .signedIn = phase, let clients = core else {
            throw .signedOut
        }
        let expectedOrg = channels.loadedOrganisation?.id ?? activeVaultOrganisationId
        let conversation = activeConversation
        return try await clients.pushWakeup.handleIncomingWakeup(
            rawPayload: rawPayload,
            expectedOrganisationId: expectedOrg
        ) { @Sendable in
            if let conversation {
                await conversation.refreshSync()
            }
        }
    }

    func openChannel(_ channel: WorkspaceChannel, organisationId: String) {
        guard case .signedIn = phase,
              case .loaded = member,
              case let .loaded(snapshot) = workspace,
              snapshot.organisationId == organisationId,
              let scope = ChannelConversationScope(organisationId: organisationId, channel: channel) else {
            return
        }
        nativeCalls?.stop(); nativeCalls = nil
        activeConversation?.clear()
        let conversationFence = SessionFence()
        let parentFenceToken = activeSessionFence.registerCancellation {
            conversationFence.invalidate()
        }
        _ = parentFenceToken
        let transport: (any ChannelConversationTransport)?
        if let customFactory = conversationTransportFactory {
            transport = customFactory(scope, core?.requester)
        } else {
            transport = makeProductionConversationTransport(scope: scope, fence: conversationFence)
        }
        activeConversation = ChannelConversationModel(
            scope: scope,
            transport: transport,
            fence: conversationFence,
            initialForeground: isForegroundActive
        )
    }

    static func conversationAuthorityLost(scope: ChannelConversationScope, state: OrganisationChannelsLoader.State) -> Bool {
        if state.member == .unavailable(.noOrganisationYet) { return true }
        if case let .loaded(snapshot) = state.workspace {
            let channels = snapshot.uncategorisedChannels + snapshot.categories.flatMap(\.channels)
            return snapshot.organisationId != scope.organisationId ||
                !channels.contains(where: { $0.id == scope.channelId && $0.lifecycle == .active })
        }
        // Reloading and transient failures preserve drafts; confirmed access loss clears them.
        return state.workspace == .unavailable(.forbidden) || state.workspace == .unavailable(.notFound) || state.workspace == .targetUnavailable
    }

    /// Provisioned adapters share the selected audio channel's authenticated timeline and session fence.
    func provisionNativeCalls(localPartyId: String, resolver: any NativeCallResolving,
                              media: any LiveKitWebRTCSession, tokens: any VoIPTokenRegistering) throws {
        guard case .signedIn = phase, case .loaded = member,
              let scope = activeConversation?.scope, scope.kind == .audio,
              let transport = activeMatrixTransport else { throw KoderaMobileFfiError.authenticationFailed }
        nativeCalls?.stop()
        let coordinator = try NativeCallCoordinator(organisationId: scope.organisationId, localPartyId: localPartyId,
            resolver: resolver, media: media, conversation: transport)
        let runtime = NativeVoIPRuntime(coordinator: coordinator, tokens: tokens)
        nativeCalls = runtime; runtime.start()
    }

    func closeChannel() {
        nativeCalls?.stop(); nativeCalls = nil
        activeConversation?.clear()
        activeConversation = nil
        activeMatrixTransport = nil
    }

    @discardableResult
    private func rotateSessionFence() -> SessionFence {
        let retiring = activeSessionFence
        activeSessionFence = SessionFence()
        retiring.invalidate()
        return retiring
    }

    @discardableResult
    private func wipeSessionVaultAndDeviceIds(invalidating retiringFence: SessionFence? = nil) -> Bool {
        defaults.removeObject(forKey: Self.vaultDeviceIdDefaultsKey)
        defaults.removeObject(forKey: Self.pushDeviceIdDefaultsKey)
        registeredPushDeviceId = nil
        do {
            try sessionVault.retireAndWipe {
                retiringFence?.invalidate()
            }
            vaultUnwiped = false
            defaults.removeObject(forKey: Self.vaultUnwipedDefaultsKey)
            return true
        } catch {
            vaultUnwiped = true
            defaults.set(true, forKey: Self.vaultUnwipedDefaultsKey)
            sessionNotWiped()
            return false
        }
    }

    private func loadOrMintVaultDeviceId() -> String? {
        if let existing = defaults.string(forKey: Self.vaultDeviceIdDefaultsKey),
           Kdv1SessionVaultCodec.isValidVaultDeviceId(existing) {
            return existing
        }
        guard let minted = (try? UuidV7Identifier.mint())?.description else {
            return nil
        }
        defaults.set(minted, forKey: Self.vaultDeviceIdDefaultsKey)
        return minted
    }

    private func makeProductionConversationTransport(
        scope: ChannelConversationScope,
        fence: SessionFence
    ) -> (any ChannelConversationTransport)? {
        guard let clients = core,
              let service,
              let coreOrigin = configuration.coreApiOrigin,
              let org = channels.loadedOrganisation,
              org.id == scope.organisationId,
              let matrixDomain = MatrixRoomClient.deriveMatrixDomain(
                  fromCoreApiOrigin: coreOrigin,
                  loopback: AppConfiguration.loopback
              ),
              let vaultDeviceId = loadOrMintVaultDeviceId() else {
            return nil
        }
        let vault = sessionVault
        let ssoAuthorizer: MatrixSsoAuthorizer
        if let authorizerFactory = matrixSsoAuthorizerFactory {
            ssoAuthorizer = authorizerFactory(fence)
        } else {
            ssoAuthorizer = { _ throws(MatrixClientFailure) -> MatrixSsoTokenGrant in
                throw .identityUnavailable
            }
        }
        let roomClient = MatrixRoomClient(
            coreRequester: clients.requester,
            loopback: AppConfiguration.loopback,
            fence: fence,
            protocolClass: matrixProtocolClass
        )
        let transport = MatrixChannelConversationTransport(
            roomClient: roomClient,
            organisationId: scope.organisationId,
            organisationSlug: org.slug,
            matrixDomain: matrixDomain,
            vaultDeviceId: vaultDeviceId,
            expectedSubjectProvider: { () async throws(MatrixClientFailure) -> String in
                try fence.checkActive()
                guard let sub = await service.authenticatedSubject(),
                      !sub.isEmpty else {
                    throw MatrixClientFailure.forbidden
                }
                try fence.checkActive()
                return sub
            },
            ssoAuthorizer: ssoAuthorizer,
            loadVault: { orgId, devId in
                guard !fence.isInvalidated else { return nil }
                return try? vault.open(organisationId: orgId, deviceId: devId)
            },
            saveVault: { (orgId: String, devId: String, plaintext: Data) throws(MatrixClientFailure) -> Bool in
                do {
                    return try vault.sealIfActive(
                        organisationId: orgId,
                        deviceId: devId,
                        plaintext: plaintext,
                        isActive: { !fence.isInvalidated }
                    ) != nil
                } catch {
                    throw MatrixClientFailure.protocolViolation
                }
            },
            onSessionEstablished: { [weak self] established in
                Task { @MainActor in
                    guard let self, !fence.isInvalidated else { return }
                    self.activeMatrixSession = established
                }
            },
            fetchWorkspace: fetchWorkspace ?? { await clients.workspace.fetch(organisationId: $0) }
        )
        activeMatrixTransport = transport
        return transport
    }

    private func enter(_ session: Session) {
        let clients = coreClients(for: session)
        core = clients
        if let clients {
            channels.enter(realm: session.realm, requester: clients.requester,
                fetchMember: { await clients.me.fetch() },
                fetchWorkspace: fetchWorkspace ?? { await clients.workspace.fetch(organisationId: $0) })
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
                           workspace: CoreWorkspaceClient(requester: requester),
                           pushWakeup: PushWakeupCoordinator(requester: requester))
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

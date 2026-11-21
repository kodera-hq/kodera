import Foundation
import KoderaDomain
#if os(iOS) && canImport(CallKit)
import CallKit
#endif
#if os(iOS) && canImport(PushKit)
import PushKit
#endif

/// Resolves encrypted MatrixRTC / LiveKit call metadata strictly over the authenticated Core session.
public protocol AuthenticatedCallStateResolver: Sendable {
    func resolveEncryptedCall(wakeup: IncomingCallWakeup) async throws -> VerifiedCallDescriptor
}

/// Abstracts OS CallKit provider actions so call state transitions remain deterministically testable.
public protocol SystemCallProviderControlling: Sendable {
    func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws
    func reportConnecting(uuid: UUID) async
    func reportConnected(uuid: UUID) async
    func reportCallEnded(uuid: UUID, reason: CallEndReason) async
}

/// Non-isolated binding hook so `CXProviderDelegate` adapters can hold a weak coordinator reference
/// without crossing Swift 6 `@MainActor` protocol conformance isolation.
public protocol SystemCallProviderCoordinatorBinding: AnyObject, Sendable {
    func bindCoordinator(_ coordinator: CallKitPushCoordinator?)
}

/// Coordinates payload-free VoIP push admission, authenticated call descriptor resolution,
/// and OS CallKit lifecycle transitions (`idle -> ringing -> connecting -> active -> muted/held -> ended/failed`).
@MainActor
public final class CallKitPushCoordinator: WorkspacePreferencesObservable {
    @WorkspacePublished public private(set) var state: CallSessionState
    @WorkspacePublished public private(set) var admissionPolicy: CallPushAdmissionPolicy
    @WorkspacePublished public private(set) var lastStrippedPushFields: Set<String> = []
    @WorkspacePublished public private(set) var isPushKitProvisioned: Bool
    public private(set) var isStopped = false

    private var resolver: (any AuthenticatedCallStateResolver)?
    private var systemProvider: (any SystemCallProviderControlling)?
    private var generation: UInt64 = 1
    // Keep native UUIDs reserved across resets until late reports and their cleanup settle.
    private var nativeReportsInFlight: Set<UUID> = []

    public init(
        admissionPolicy: CallPushAdmissionPolicy = .rejectCleartext,
        resolver: (any AuthenticatedCallStateResolver)? = nil,
        systemProvider: (any SystemCallProviderControlling)? = nil
    ) {
        self.state = CallSessionState()
        self.admissionPolicy = admissionPolicy
        self.resolver = resolver
        self.systemProvider = systemProvider
        self.isPushKitProvisioned = (resolver != nil && systemProvider != nil)
        (systemProvider as? any SystemCallProviderCoordinatorBinding)?.bindCoordinator(self)
    }

    public init(
        organisationId: String?,
        admissionPolicy: CallPushAdmissionPolicy = .rejectCleartext,
        resolver: (any AuthenticatedCallStateResolver)? = nil,
        systemProvider: (any SystemCallProviderControlling)? = nil
    ) throws {
        self.state = try CallSessionState(organisationId: organisationId)
        self.admissionPolicy = admissionPolicy
        self.resolver = resolver
        self.systemProvider = systemProvider
        self.isPushKitProvisioned = (resolver != nil && systemProvider != nil)
        (systemProvider as? any SystemCallProviderCoordinatorBinding)?.bindCoordinator(self)
    }

    public func updateAdapters(
        resolver: (any AuthenticatedCallStateResolver)?,
        systemProvider: (any SystemCallProviderControlling)?
    ) {
        guard !isStopped else { return }
        (self.systemProvider as? any SystemCallProviderCoordinatorBinding)?.bindCoordinator(nil)
        self.resolver = resolver
        self.systemProvider = systemProvider
        (systemProvider as? any SystemCallProviderCoordinatorBinding)?.bindCoordinator(self)
        self.isPushKitProvisioned = (resolver != nil && systemProvider != nil)
        advanceGeneration()
    }

    public func switchOrganisation(_ incomingOrganisationId: String?) async throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        let previousUUID = state.activeCallUUID
        let previousOrganisation = state.organisationId
        try state.configureOrganisation(incomingOrganisationId)
        lastStrippedPushFields = []
        advanceGeneration()
        if let previousUUID, previousOrganisation != incomingOrganisationId {
            await systemProvider?.reportCallEnded(uuid: previousUUID, reason: .organisationChanged)
        }
    }

    public func handleIncomingPushData(_ jsonData: Data) async -> Result<IncomingCallWakeup, CallWakeupError> {
        guard !isStopped, generation != 0 else { return .failure(.stopped) }
        do {
            let admitted = try PayloadFreePushEnvelope.admit(jsonData: jsonData, policy: admissionPolicy)
            return await processAdmittedPush(admitted)
        } catch let error as CallWakeupError {
            recordIdleFailure(.untrustedPushPayload)
            return .failure(error)
        } catch {
            recordIdleFailure(.untrustedPushPayload)
            return .failure(.invalidPayloadFormat)
        }
    }

    public func handleIncomingPushPayload(
        _ jsonObject: [String: Any]
    ) async -> Result<IncomingCallWakeup, CallWakeupError> {
        guard !isStopped, generation != 0 else { return .failure(.stopped) }
        do {
            let admitted = try PayloadFreePushEnvelope.admit(jsonObject: jsonObject, policy: admissionPolicy)
            return await processAdmittedPush(admitted)
        } catch let error as CallWakeupError {
            recordIdleFailure(.untrustedPushPayload)
            return .failure(error)
        } catch {
            recordIdleFailure(.untrustedPushPayload)
            return .failure(.invalidPayloadFormat)
        }
    }

    private func processAdmittedPush(
        _ admitted: PayloadFreePushResult
    ) async -> Result<IncomingCallWakeup, CallWakeupError> {
        lastStrippedPushFields = admitted.strippedFieldNames

        guard let currentOrg = state.organisationId,
              currentOrg == admitted.envelope.organisationId else {
            recordIdleFailure(.organisationMismatch)
            return .failure(.organisationMismatch)
        }
        guard state.activeCallUUID == nil else {
            return .failure(.invalidTransition)
        }
        guard let resolver else {
            recordIdleFailure(.unauthenticatedSession)
            return .failure(.invalidCallDescriptor)
        }

        let wakeup = IncomingCallWakeup(envelope: admitted.envelope)
        let wakeupGeneration = generation

        let descriptor: VerifiedCallDescriptor
        do {
            descriptor = try await resolver.resolveEncryptedCall(wakeup: wakeup)
        } catch {
            guard !isStopped, generation == wakeupGeneration else {
                return .failure(.organisationMismatch)
            }
            recordIdleFailure(.callResolutionFailed)
            return .failure(.invalidCallDescriptor)
        }

        guard !isStopped, generation == wakeupGeneration, state.organisationId == currentOrg else {
            return .failure(.organisationMismatch)
        }

        guard !nativeReportsInFlight.contains(wakeup.callUUID) else {
            return .failure(.invalidTransition)
        }
        do {
            try state.beginRinging(wakeup: wakeup, descriptor: descriptor)
        } catch let error as CallWakeupError {
            return .failure(error)
        } catch {
            return .failure(.invalidTransition)
        }

        if let systemProvider {
            nativeReportsInFlight.insert(wakeup.callUUID)
            defer { nativeReportsInFlight.remove(wakeup.callUUID) }
            do {
                try await systemProvider.reportIncomingCall(
                    uuid: wakeup.callUUID,
                    callerLabel: descriptor.callerLabel,
                    hasVideo: descriptor.hasVideo
                )
            } catch {
                guard matchesCall(generation: wakeupGeneration, organisationId: currentOrg, uuid: wakeup.callUUID) else {
                    await systemProvider.reportCallEnded(uuid: wakeup.callUUID, reason: .organisationChanged)
                    return .failure(.organisationMismatch)
                }
                state.recordFailure(.callKitRejected)
                return .failure(.invalidTransition)
            }
            guard matchesCall(generation: wakeupGeneration, organisationId: currentOrg, uuid: wakeup.callUUID) else {
                await systemProvider.reportCallEnded(uuid: wakeup.callUUID, reason: .organisationChanged)
                return .failure(.organisationMismatch)
            }
        }
        return .success(wakeup)
    }

    public func answerCall(uuid: UUID) async throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.acceptAnswer()
        await systemProvider?.reportConnecting(uuid: uuid)
    }

    public func declineIncomingCall(uuid: UUID) async throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.declineIncoming()
        await systemProvider?.reportCallEnded(uuid: uuid, reason: .declined)
    }

    public func markMediaConnected(uuid: UUID) async throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.markConnected()
        await systemProvider?.reportConnected(uuid: uuid)
    }

    public func setMuted(_ muted: Bool, uuid: UUID) throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.setMuted(muted)
    }

    public func setHeld(_ held: Bool, uuid: UUID) throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.setHeld(held)
    }

    public func setVideoEnabled(_ enabled: Bool, uuid: UUID) throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.setVideoEnabled(enabled)
    }

    public func endCall(uuid: UUID, reason: CallEndReason = .localHangup) async throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        guard state.activeCallUUID == uuid else { throw CallWakeupError.invalidTransition }
        try state.endCall(reason: reason)
        await systemProvider?.reportCallEnded(uuid: uuid, reason: reason)
    }

    public func failActiveCall(uuid: UUID, reason: CallFailureReason) async {
        guard !isStopped, state.activeCallUUID == uuid else { return }
        state.recordFailure(reason)
        await systemProvider?.reportCallEnded(uuid: uuid, reason: .remoteEnded)
    }

    public func resetToIdle() throws {
        guard !isStopped else { throw CallWakeupError.stopped }
        try state.resetToIdle()
    }

    /// Invoked by `CallKitSystemProviderAdapter` when the system CallKit UI answers the active incoming call.
    public func handleSystemAnswerCall(uuid: UUID) -> Bool {
        guard !isStopped, state.activeCallUUID == uuid else { return false }
        do {
            try state.acceptAnswer()
            return true
        } catch {
            return false
        }
    }

    /// Invoked by `CallKitSystemProviderAdapter` when the system CallKit UI declines or ends the active call.
    public func handleSystemEndCall(uuid: UUID) -> Bool {
        guard !isStopped, state.activeCallUUID == uuid else { return false }
        do {
            if case .ringing = state.phase {
                try state.declineIncoming()
            } else {
                try state.endCall(reason: .localHangup)
            }
            return true
        } catch {
            return false
        }
    }

    /// Invoked by `CallKitSystemProviderAdapter` when the system CallKit UI toggles mute.
    public func handleSystemSetMuted(_ muted: Bool, uuid: UUID) -> Bool {
        guard !isStopped else { return false }
        return (try? setMuted(muted, uuid: uuid)) != nil
    }

    /// Invoked by `CallKitSystemProviderAdapter` when the system CallKit UI toggles hold.
    public func handleSystemSetHeld(_ held: Bool, uuid: UUID) -> Bool {
        guard !isStopped else { return false }
        return (try? setHeld(held, uuid: uuid)) != nil
    }

    /// Invoked by `CallKitSystemProviderAdapter` on `providerDidReset(_:)`.
    public func handleSystemProviderDidReset() {
        guard !isStopped else { return }
        nativeReportsInFlight.removeAll()
        state.resetAfterSystemProviderReset()
    }

    public func stop() async {
        let activeUUID = state.activeCallUUID
        isStopped = true
        generation = 0
        lastStrippedPushFields = []
        isPushKitProvisioned = false
        try? state.configureOrganisation(nil)
        if let activeUUID {
            await systemProvider?.reportCallEnded(uuid: activeUUID, reason: .organisationChanged)
        }
        (systemProvider as? any SystemCallProviderCoordinatorBinding)?.bindCoordinator(nil)
        resolver = nil
        systemProvider = nil
    }

    private func matchesCall(generation expected: UInt64, organisationId: String, uuid: UUID) -> Bool {
        !isStopped && generation == expected && state.organisationId == organisationId
            && state.activeCallUUID == uuid
    }

    private func recordIdleFailure(_ reason: CallFailureReason) {
        guard state.activeCallUUID == nil else { return }
        state.recordFailure(reason)
    }

    private func advanceGeneration() {
        if generation == 0 || generation == UInt64.max {
            generation = 0
            isStopped = true
        } else {
            generation += 1
        }
    }
}

/// Normalized incoming CallKit call metadata snapshot passed to `CXCallUpdate` on iOS and verified in unit tests.
public struct CallKitIncomingUpdateSnapshot: Equatable, Sendable {
    public let handleValue: String?
    public let localizedCallerName: String?
    public let hasVideo: Bool
    public let supportsHolding: Bool
    public let supportsGrouping: Bool
    public let supportsUngrouping: Bool
    public let supportsDTMF: Bool

    public init(
        handleValue: String?,
        localizedCallerName: String?,
        hasVideo: Bool,
        supportsHolding: Bool = true,
        supportsGrouping: Bool = false,
        supportsUngrouping: Bool = false,
        supportsDTMF: Bool = false
    ) {
        self.handleValue = handleValue
        self.localizedCallerName = localizedCallerName
        self.hasVideo = hasVideo
        self.supportsHolding = supportsHolding
        self.supportsGrouping = supportsGrouping
        self.supportsUngrouping = supportsUngrouping
        self.supportsDTMF = supportsDTMF
    }
}

/// Platform-neutral driver seam backing `CallKitSystemProviderAdapter` so `swift test` on macOS and iOS both
/// exercise exact incoming-vs-outgoing call routing and `CXCallAction` fulfillment/failure semantics.
public protocol CallKitProviderDriving: AnyObject, Sendable {
    func didConfigureDelegate(queueIsNil: Bool)
    func reportNewIncomingCall(uuid: UUID, update: CallKitIncomingUpdateSnapshot) async throws
    func reportCallUpdated(uuid: UUID, update: CallKitIncomingUpdateSnapshot)
    func reportOutgoingCallConnecting(uuid: UUID, startedConnectingAt: Date)
    func reportOutgoingCallConnected(uuid: UUID, connectedAt: Date)
    func reportCallEnded(uuid: UUID, endedAt: Date, reason: CallEndReason)
}

/// Core CallKit provider routing engine shared by `CallKitSystemProviderAdapter` on iOS and unit tests.
public final class CallKitProviderRoutingEngine: SystemCallProviderControlling,
    SystemCallProviderCoordinatorBinding,
    @unchecked Sendable
{
    private struct IncomingMetadata {
        let callerLabel: String
        let hasVideo: Bool
    }

    private enum CallDirection {
        case incoming(IncomingMetadata)
        case outgoing
        case unknown
    }

    private let driver: any CallKitProviderDriving
    private let stateLock = NSLock()
    private var incomingCalls: [UUID: IncomingMetadata] = [:]
    private var outgoingCalls: Set<UUID> = []
    private weak var coordinator: CallKitPushCoordinator?

    public init(
        driver: any CallKitProviderDriving,
        coordinator: CallKitPushCoordinator? = nil
    ) {
        self.driver = driver
        self.coordinator = coordinator
        driver.didConfigureDelegate(queueIsNil: true)
    }

    public func bindCoordinator(_ coordinator: CallKitPushCoordinator?) {
        stateLock.withLock {
            self.coordinator = coordinator
        }
    }

    private func currentCoordinator() -> CallKitPushCoordinator? {
        stateLock.withLock { coordinator }
    }

    public func registerOutgoingCall(uuid: UUID) {
        stateLock.withLock {
            _ = incomingCalls.removeValue(forKey: uuid)
            _ = outgoingCalls.insert(uuid)
        }
    }

    public func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws {
        let snapshot = Self.makeIncomingSnapshot(uuid: uuid, callerLabel: callerLabel, hasVideo: hasVideo)
        stateLock.withLock {
            _ = outgoingCalls.remove(uuid)
            incomingCalls[uuid] = IncomingMetadata(callerLabel: callerLabel, hasVideo: hasVideo)
        }
        do {
            try await driver.reportNewIncomingCall(uuid: uuid, update: snapshot)
        } catch {
            stateLock.withLock {
                _ = incomingCalls.removeValue(forKey: uuid)
            }
            throw error
        }
    }

    public func reportConnecting(uuid: UUID) async {
        switch lookupDirection(uuid: uuid) {
        case .outgoing:
            driver.reportOutgoingCallConnecting(uuid: uuid, startedConnectingAt: Date())
        case let .incoming(meta):
            let snapshot = Self.makeIncomingSnapshot(uuid: uuid, callerLabel: meta.callerLabel, hasVideo: meta.hasVideo)
            driver.reportCallUpdated(uuid: uuid, update: snapshot)
        case .unknown:
            let snapshot = CallKitIncomingUpdateSnapshot(
                handleValue: nil,
                localizedCallerName: nil,
                hasVideo: false
            )
            driver.reportCallUpdated(uuid: uuid, update: snapshot)
        }
    }

    public func reportConnected(uuid: UUID) async {
        switch lookupDirection(uuid: uuid) {
        case .outgoing:
            driver.reportOutgoingCallConnected(uuid: uuid, connectedAt: Date())
        case let .incoming(meta):
            let snapshot = Self.makeIncomingSnapshot(uuid: uuid, callerLabel: meta.callerLabel, hasVideo: meta.hasVideo)
            driver.reportCallUpdated(uuid: uuid, update: snapshot)
        case .unknown:
            let snapshot = CallKitIncomingUpdateSnapshot(
                handleValue: nil,
                localizedCallerName: nil,
                hasVideo: false
            )
            driver.reportCallUpdated(uuid: uuid, update: snapshot)
        }
    }

    public func reportCallEnded(uuid: UUID, reason: CallEndReason) async {
        stateLock.withLock {
            _ = incomingCalls.removeValue(forKey: uuid)
            _ = outgoingCalls.remove(uuid)
        }
        driver.reportCallEnded(uuid: uuid, endedAt: Date(), reason: reason)
    }

    public func performProviderDidReset() {
        let bound = stateLock.withLock { () -> CallKitPushCoordinator? in
            incomingCalls.removeAll()
            outgoingCalls.removeAll()
            return coordinator
        }

        if Thread.isMainThread {
            MainActor.assumeIsolated {
                bound?.handleSystemProviderDidReset()
            }
        } else {
            Task { @MainActor in
                bound?.handleSystemProviderDidReset()
            }
        }
    }

    public func performAnswerCallAction(
        uuid: UUID,
        fulfill: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable () -> Void
    ) {
        dispatchAction(
            { coordinator in coordinator?.handleSystemAnswerCall(uuid: uuid) ?? false },
            fulfill: fulfill,
            fail: fail
        )
    }

    public func performEndCallAction(
        uuid: UUID,
        fulfill: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable () -> Void
    ) {
        stateLock.withLock {
            _ = incomingCalls.removeValue(forKey: uuid)
            _ = outgoingCalls.remove(uuid)
        }

        dispatchAction(
            { coordinator in coordinator?.handleSystemEndCall(uuid: uuid) ?? false },
            fulfill: fulfill,
            fail: fail
        )
    }

    public func performSetMutedCallAction(
        uuid: UUID,
        muted: Bool,
        fulfill: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable () -> Void
    ) {
        dispatchAction(
            { coordinator in coordinator?.handleSystemSetMuted(muted, uuid: uuid) ?? false },
            fulfill: fulfill,
            fail: fail
        )
    }

    public func performSetHeldCallAction(
        uuid: UUID,
        onHold: Bool,
        fulfill: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable () -> Void
    ) {
        dispatchAction(
            { coordinator in coordinator?.handleSystemSetHeld(onHold, uuid: uuid) ?? false },
            fulfill: fulfill,
            fail: fail
        )
    }

    private func dispatchAction(
        _ body: @escaping @Sendable @MainActor (CallKitPushCoordinator?) -> Bool,
        fulfill: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable () -> Void
    ) {
        let bound = currentCoordinator()
        if Thread.isMainThread {
            let ok = MainActor.assumeIsolated { body(bound) }
            if ok { fulfill() } else { fail() }
        } else {
            Task { @MainActor in
                let ok = body(bound)
                if ok { fulfill() } else { fail() }
            }
        }
    }

    private func lookupDirection(uuid: UUID) -> CallDirection {
        stateLock.withLock {
            if outgoingCalls.contains(uuid) {
                return .outgoing
            }
            if let meta = incomingCalls[uuid] {
                return .incoming(meta)
            }
            return .unknown
        }
    }

    private static func makeIncomingSnapshot(
        uuid: UUID,
        callerLabel: String,
        hasVideo: Bool
    ) -> CallKitIncomingUpdateSnapshot {
        CallKitIncomingUpdateSnapshot(
            handleValue: uuid.uuidString.lowercased(),
            localizedCallerName: callerLabel,
            hasVideo: hasVideo,
            supportsHolding: true,
            supportsGrouping: false,
            supportsUngrouping: false,
            supportsDTMF: false
        )
    }
}

#if os(iOS) && canImport(PushKit)
/// Bridges `PKPushPayload` dictionaries into validated payload-free envelopes without trusting relay strings.
public enum PushKitPayloadExtractor {
    public static func admit(
        pushPayload: PKPushPayload,
        policy: CallPushAdmissionPolicy = .rejectCleartext
    ) throws -> PayloadFreePushResult {
        try admit(rawDictionary: pushPayload.dictionaryPayload, policy: policy)
    }

    public static func admit(
        rawDictionary: [AnyHashable: Any],
        policy: CallPushAdmissionPolicy = .rejectCleartext
    ) throws -> PayloadFreePushResult {
        var normalized: [String: Any] = [:]
        for (key, value) in rawDictionary {
            guard let stringKey = key as? String else {
                throw CallWakeupError.invalidPayloadFormat
            }
            normalized[stringKey] = value
        }
        return try PayloadFreePushEnvelope.admit(jsonObject: normalized, policy: policy)
    }
}
#endif

#if os(iOS) && canImport(CallKit)
private final class SystemCXProviderDriver: CallKitProviderDriving, @unchecked Sendable {
    let provider: CXProvider

    init(provider: CXProvider) {
        self.provider = provider
    }

    func didConfigureDelegate(queueIsNil _: Bool) {}

    func reportNewIncomingCall(uuid: UUID, update: CallKitIncomingUpdateSnapshot) async throws {
        try await provider.reportNewIncomingCall(with: uuid, update: Self.toCXCallUpdate(update))
    }

    func reportCallUpdated(uuid: UUID, update: CallKitIncomingUpdateSnapshot) {
        provider.reportCall(with: uuid, updated: Self.toCXCallUpdate(update))
    }

    func reportOutgoingCallConnecting(uuid: UUID, startedConnectingAt: Date) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: startedConnectingAt)
    }

    func reportOutgoingCallConnected(uuid: UUID, connectedAt: Date) {
        provider.reportOutgoingCall(with: uuid, connectedAt: connectedAt)
    }

    func reportCallEnded(uuid: UUID, endedAt: Date, reason: CallEndReason) {
        let cxReason: CXCallEndedReason
        switch reason {
        case .remoteEnded, .localHangup, .organisationChanged:
            cxReason = .remoteEnded
        case .declined:
            cxReason = .declinedElsewhere
        case .unansweredTimeout:
            cxReason = .unanswered
        }
        provider.reportCall(with: uuid, endedAt: endedAt, reason: cxReason)
    }

    private static func toCXCallUpdate(_ snapshot: CallKitIncomingUpdateSnapshot) -> CXCallUpdate {
        let update = CXCallUpdate()
        if let caller = snapshot.localizedCallerName {
            update.localizedCallerName = caller
        }
        if let handle = snapshot.handleValue {
            update.remoteHandle = CXHandle(type: .generic, value: handle)
        }
        update.hasVideo = snapshot.hasVideo
        update.supportsHolding = snapshot.supportsHolding
        update.supportsGrouping = snapshot.supportsGrouping
        update.supportsUngrouping = snapshot.supportsUngrouping
        update.supportsDTMF = snapshot.supportsDTMF
        return update
    }
}

private struct SystemCallActionCompletionBox: @unchecked Sendable {
    let action: CXCallAction

    func fulfill() {
        action.fulfill()
    }

    func fail() {
        action.fail()
    }
}

/// System `CXProvider` adapter configured with `includesCallsInRecents = false` to prevent call metadata leakage.
/// Assigns `provider.setDelegate(self, queue: nil)`, routes `CXCallAction` and `providerDidReset` events back into
/// `CallKitPushCoordinator`, and updates incoming calls via `CXCallUpdate` / `reportCall(with:updated:)` rather than
/// `reportOutgoingCall`.
public final class CallKitSystemProviderAdapter: NSObject,
    CXProviderDelegate,
    SystemCallProviderControlling,
    SystemCallProviderCoordinatorBinding,
    @unchecked Sendable
{
    private let provider: CXProvider
    private let engine: CallKitProviderRoutingEngine

    public override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.includesCallsInRecents = false
        configuration.supportedHandleTypes = [.generic]
        let cxProvider = CXProvider(configuration: configuration)
        let driver = SystemCXProviderDriver(provider: cxProvider)
        self.provider = cxProvider
        self.engine = CallKitProviderRoutingEngine(driver: driver)
        super.init()
        cxProvider.setDelegate(self, queue: nil)
    }

    public convenience init(localizedAppName _: String, coordinator: CallKitPushCoordinator? = nil) {
        self.init()
        if let coordinator {
            engine.bindCoordinator(coordinator)
        }
    }

    public func bindCoordinator(_ coordinator: CallKitPushCoordinator?) {
        engine.bindCoordinator(coordinator)
    }

    public func registerOutgoingCall(uuid: UUID) {
        engine.registerOutgoingCall(uuid: uuid)
    }

    public func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws {
        try await engine.reportIncomingCall(uuid: uuid, callerLabel: callerLabel, hasVideo: hasVideo)
    }

    public func reportConnecting(uuid: UUID) async {
        await engine.reportConnecting(uuid: uuid)
    }

    public func reportConnected(uuid: UUID) async {
        await engine.reportConnected(uuid: uuid)
    }

    public func reportCallEnded(uuid: UUID, reason: CallEndReason) async {
        await engine.reportCallEnded(uuid: uuid, reason: reason)
    }

    public func providerDidReset(_: CXProvider) {
        engine.performProviderDidReset()
    }

    public func provider(_: CXProvider, perform action: CXAnswerCallAction) {
        let box = SystemCallActionCompletionBox(action: action)
        engine.performAnswerCallAction(
            uuid: action.callUUID,
            fulfill: { box.fulfill() },
            fail: { box.fail() }
        )
    }

    public func provider(_: CXProvider, perform action: CXEndCallAction) {
        let box = SystemCallActionCompletionBox(action: action)
        engine.performEndCallAction(
            uuid: action.callUUID,
            fulfill: { box.fulfill() },
            fail: { box.fail() }
        )
    }

    public func provider(_: CXProvider, perform action: CXSetMutedCallAction) {
        let box = SystemCallActionCompletionBox(action: action)
        engine.performSetMutedCallAction(
            uuid: action.callUUID,
            muted: action.isMuted,
            fulfill: { box.fulfill() },
            fail: { box.fail() }
        )
    }

    public func provider(_: CXProvider, perform action: CXSetHeldCallAction) {
        let box = SystemCallActionCompletionBox(action: action)
        engine.performSetHeldCallAction(
            uuid: action.callUUID,
            onHold: action.isOnHold,
            fulfill: { box.fulfill() },
            fail: { box.fail() }
        )
    }
}
#endif

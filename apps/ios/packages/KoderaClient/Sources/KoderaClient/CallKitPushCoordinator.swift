import Foundation
import KoderaDomain
#if os(iOS) && canImport(CallKit) && canImport(PushKit)
import CallKit
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
        organisationId: String? = nil,
        admissionPolicy: CallPushAdmissionPolicy = .rejectCleartext,
        resolver: (any AuthenticatedCallStateResolver)? = nil,
        systemProvider: (any SystemCallProviderControlling)? = nil
    ) throws {
        self.state = try CallSessionState(organisationId: organisationId)
        self.admissionPolicy = admissionPolicy
        self.resolver = resolver
        self.systemProvider = systemProvider
        self.isPushKitProvisioned = (resolver != nil && systemProvider != nil)
    }

    public func updateAdapters(
        resolver: (any AuthenticatedCallStateResolver)?,
        systemProvider: (any SystemCallProviderControlling)?
    ) {
        guard !isStopped else { return }
        self.resolver = resolver
        self.systemProvider = systemProvider
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

#if os(iOS) && canImport(CallKit) && canImport(PushKit)
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

/// System `CXProvider` adapter configured with `includesCallsInRecents = false` to prevent call metadata leakage.
public final class CallKitSystemProviderAdapter: NSObject, SystemCallProviderControlling, @unchecked Sendable {
    private let provider: CXProvider

    public init(localizedAppName: String) {
        let configuration = CXProviderConfiguration(localizedName: localizedAppName)
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.includesCallsInRecents = false
        configuration.supportedHandleTypes = [.generic]
        self.provider = CXProvider(configuration: configuration)
        super.init()
    }

    public func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws {
        let update = CXCallUpdate()
        update.localizedCallerName = callerLabel
        update.remoteHandle = CXHandle(type: .generic, value: uuid.uuidString.lowercased())
        update.hasVideo = hasVideo
        update.supportsHolding = true
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        try await provider.reportNewIncomingCall(with: uuid, update: update)
    }

    public func reportConnecting(uuid: UUID) async {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    public func reportConnected(uuid: UUID) async {
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    public func reportCallEnded(uuid: UUID, reason: CallEndReason) async {
        let cxReason: CXCallEndedReason
        switch reason {
        case .remoteEnded, .localHangup, .organisationChanged:
            cxReason = .remoteEnded
        case .declined:
            cxReason = .declinedElsewhere
        case .unansweredTimeout:
            cxReason = .unanswered
        }
        provider.reportCall(with: uuid, endedAt: Date(), reason: cxReason)
    }
}
#endif

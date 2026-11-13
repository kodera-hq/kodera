import Foundation
import KoderaDomain

/// Online Matrix room relay status — kept strictly separate from local BLE radio check-ins.
public enum OnlineMatrixRelayStatus: Equatable, Sendable {
    case disconnected
    case connectedRoom(roomId: String)
}

/// Local BLE `#proximity` v2 radio surface status.
public enum LocalBLERadioStatus: Equatable, Sendable {
    case unprovisioned
    case awaitingForegroundConsent
    case suspendedInBackground
    case throttled(ProximityBeaconV2Error)
    case scanningWindowActive(startedAtUnixSeconds: UInt64, expiresAtUnixSeconds: UInt64)
    case readyForLocalRadio
}

/// Physical BLE radio adapter seam. No hardware radio claims delivery unless this adapter completes.
public protocol ProximityV2RadioTransport: Sendable {
    func startScanWindow(durationSeconds: UInt64) async throws
    func stopScanWindow() async
    func broadcastBeacon(_ beacon: ProximityBeaconV2, status: ProximitySafetyStatus) async throws
}

/// Trusted per-organisation v2 beacon provisioning bundle.
public struct ProximityV2RadioProvisioning: Sendable {
    public let organisationId: String
    public let sender: ProximityBeaconV2Sender
    public let receiver: ProximityBeaconV2Receiver
    public let transport: any ProximityV2RadioTransport

    public init(
        organisationId: String,
        sender: ProximityBeaconV2Sender,
        receiver: ProximityBeaconV2Receiver,
        transport: any ProximityV2RadioTransport
    ) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.organisationId = organisationId
        self.sender = sender
        self.receiver = receiver
        self.transport = transport
    }
}

/// Foreground opt-in `#proximity` v2 controller enforcing duty-cycle/battery bounds,
/// rotating v2 beacon emission/replay checks, and strict separation between online Matrix relays
/// and verified local BLE radio frames.
@MainActor
public final class ProximityV2CheckInController: WorkspacePreferencesObservable {
    public static let maxStoredObservations = 64

    @WorkspacePublished public private(set) var organisationId: String?
    @WorkspacePublished public private(set) var draft = ProximityCheckInDraft()
    @WorkspacePublished public private(set) var hasForegroundConsent = false
    @WorkspacePublished public private(set) var isForegroundActive = true
    @WorkspacePublished public private(set) var battery: ProximityBatterySnapshot
    @WorkspacePublished public private(set) var budget: ProximityDutyCycleBudget
    @WorkspacePublished public private(set) var onlineMatrixRelayStatus: OnlineMatrixRelayStatus = .disconnected
    @WorkspacePublished public private(set) var localRadioStatus: LocalBLERadioStatus = .awaitingForegroundConsent
    @WorkspacePublished public private(set) var verifiedLocalBroadcastCount = 0
    @WorkspacePublished public private(set) var verifiedPeerObservations: [BeaconObservationV2] = []
    @WorkspacePublished public private(set) var lastError: ProximityBeaconV2Error?

    public var isProvisionedForLocalRadio: Bool { sender != nil && receiver != nil && transport != nil }
    public var hasVerifiedLocalRadioDelivery: Bool { verifiedLocalBroadcastCount > 0 }

    private var sender: ProximityBeaconV2Sender?
    private var receiver: ProximityBeaconV2Receiver?
    private var transport: (any ProximityV2RadioTransport)?
    private var lastScanStartedAt: UInt64?
    private var activeEmissionWindow: UInt32?
    private var emissionsInCurrentWindow = 0
    private var generation: UInt64 = 1

    public init(
        battery: ProximityBatterySnapshot = .nominal,
        budget: ProximityDutyCycleBudget = .standard
    ) {
        self.battery = battery
        self.budget = budget
        refreshRadioStatus()
    }

    public func configure(
        organisationId incomingOrganisationId: String?,
        provisioning: ProximityV2RadioProvisioning? = nil,
        onlineMatrixRoomId: String? = nil
    ) {
        advanceGeneration()
        hasForegroundConsent = false
        verifiedLocalBroadcastCount = 0
        verifiedPeerObservations = []
        lastScanStartedAt = nil
        activeEmissionWindow = nil
        emissionsInCurrentWindow = 0
        lastError = nil

        guard draft.configure(organisationId: incomingOrganisationId),
              let validOrg = draft.organisationId else {
            organisationId = nil
            sender = nil
            receiver = nil
            transport = nil
            onlineMatrixRelayStatus = .disconnected
            refreshRadioStatus()
            return
        }

        organisationId = validOrg
        if let provisioning, provisioning.organisationId == validOrg {
            sender = provisioning.sender
            receiver = provisioning.receiver
            transport = provisioning.transport
        } else {
            sender = nil
            receiver = nil
            transport = nil
        }

        if let onlineMatrixRoomId, VoiceCallScope.boundedText(onlineMatrixRoomId) {
            onlineMatrixRelayStatus = .connectedRoom(roomId: onlineMatrixRoomId)
        } else {
            onlineMatrixRelayStatus = .disconnected
        }
        refreshRadioStatus()
    }

    public func setOnlineMatrixRelayStatus(_ status: OnlineMatrixRelayStatus) {
        onlineMatrixRelayStatus = status
    }

    public func setForegroundActive(_ active: Bool) {
        guard isForegroundActive != active else { return }
        isForegroundActive = active
        if !active {
            let activeTransport = transport
            advanceGeneration()
            if let activeTransport {
                Task { await activeTransport.stopScanWindow() }
            }
        }
        refreshRadioStatus()
    }

    public func grantForegroundConsent(forOrganisationId incomingOrganisationId: String?) throws {
        guard let organisationId, incomingOrganisationId == organisationId else {
            throw ProximityBeaconV2Error.scopeMismatch
        }
        guard isForegroundActive else {
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }
        hasForegroundConsent = true
        lastError = nil
        refreshRadioStatus()
    }

    public func revokeConsent() {
        let activeTransport = transport
        hasForegroundConsent = false
        lastError = nil
        advanceGeneration()
        if let activeTransport {
            Task { await activeTransport.stopScanWindow() }
        }
        refreshRadioStatus()
    }

    public func updateBattery(_ snapshot: ProximityBatterySnapshot) {
        battery = snapshot
        refreshRadioStatus()
    }

    @discardableResult
    public func prepareDraft(_ status: ProximitySafetyStatus) -> Bool {
        let context = draft.preparationContext(forOrganisationId: organisationId)
        return draft.prepare(status, context: context)
    }

    public func clearDraft() {
        let org = organisationId
        _ = draft.configure(organisationId: org)
    }

    public func startScanWindow(
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) async throws {
        guard organisationId != nil else {
            throw ProximityBeaconV2Error.scopeMismatch
        }
        guard isForegroundActive, hasForegroundConsent else {
            lastError = .foregroundConsentRequired
            refreshRadioStatus()
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }
        guard let transport, isProvisionedForLocalRadio else {
            lastError = .invalidInput
            refreshRadioStatus()
            throw ProximityBeaconV2Error.invalidInput
        }

        do {
            try budget.validateScanStart(
                battery: battery,
                lastScanStartedAt: lastScanStartedAt,
                nowUnixSeconds: nowUnixSeconds
            )
        } catch let error as ProximityBeaconV2Error {
            lastError = error
            localRadioStatus = .throttled(error)
            throw error
        }

        let capturedGeneration = generation
        try await transport.startScanWindow(durationSeconds: budget.maxScanWindowSeconds)
        guard generation == capturedGeneration, isForegroundActive, hasForegroundConsent else {
            await transport.stopScanWindow()
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }

        lastScanStartedAt = nowUnixSeconds
        lastError = nil
        localRadioStatus = .scanningWindowActive(
            startedAtUnixSeconds: nowUnixSeconds,
            expiresAtUnixSeconds: nowUnixSeconds + budget.maxScanWindowSeconds
        )
    }

    @discardableResult
    public func emitCheckInOverLocalRadio(
        status: ProximitySafetyStatus,
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) async throws -> ProximityBeaconV2 {
        guard status != .messageOnly else {
            throw ProximityBeaconV2Error.invalidInput
        }
        guard organisationId != nil else {
            throw ProximityBeaconV2Error.scopeMismatch
        }
        guard isForegroundActive, hasForegroundConsent else {
            lastError = .foregroundConsentRequired
            refreshRadioStatus()
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }
        guard var nextSender = sender, let transport else {
            lastError = .invalidInput
            refreshRadioStatus()
            throw ProximityBeaconV2Error.invalidInput
        }

        let currentWindow = UInt32(truncatingIfNeeded: nowUnixSeconds / ProximityBeaconV2.rotationWindowSeconds)
        let windowCount = (activeEmissionWindow == currentWindow) ? emissionsInCurrentWindow : 0
        do {
            try budget.validateBroadcast(battery: battery, emissionsInCurrentWindow: windowCount)
        } catch let error as ProximityBeaconV2Error {
            lastError = error
            localRadioStatus = .throttled(error)
            throw error
        }

        let beacon = try nextSender.emit(atUnixSeconds: nowUnixSeconds)
        let capturedGeneration = generation
        try await transport.broadcastBeacon(beacon, status: status)

        guard generation == capturedGeneration, isForegroundActive, hasForegroundConsent else {
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }

        sender = nextSender
        activeEmissionWindow = currentWindow
        emissionsInCurrentWindow = windowCount + 1
        verifiedLocalBroadcastCount += 1
        _ = prepareDraft(status)
        lastError = nil
        refreshRadioStatus()
        return beacon
    }

    @discardableResult
    public func ingestObservedPeerBeacon(
        _ rawBytes: Data,
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) throws -> BeaconObservationV2 {
        guard organisationId != nil else {
            throw ProximityBeaconV2Error.scopeMismatch
        }
        guard isForegroundActive, hasForegroundConsent else {
            throw ProximityBeaconV2Error.foregroundConsentRequired
        }
        guard var nextReceiver = receiver else {
            throw ProximityBeaconV2Error.invalidInput
        }

        let observation = try nextReceiver.accept(bytes: rawBytes, nowUnixSeconds: nowUnixSeconds)
        receiver = nextReceiver
        if verifiedPeerObservations.count == Self.maxStoredObservations {
            verifiedPeerObservations.removeFirst()
        }
        verifiedPeerObservations.append(observation)
        return observation
    }

    private func refreshRadioStatus() {
        guard organisationId != nil else {
            localRadioStatus = .unprovisioned
            return
        }
        guard hasForegroundConsent else {
            localRadioStatus = .awaitingForegroundConsent
            return
        }
        guard isForegroundActive else {
            localRadioStatus = .suspendedInBackground
            return
        }
        do {
            try budget.validateBattery(battery)
        } catch let error as ProximityBeaconV2Error {
            localRadioStatus = .throttled(error)
            return
        } catch {
            localRadioStatus = .throttled(.batteryBudgetExceeded)
            return
        }
        guard isProvisionedForLocalRadio else {
            localRadioStatus = .unprovisioned
            return
        }
        localRadioStatus = .readyForLocalRadio
    }

    private func advanceGeneration() {
        if generation < UInt64.max {
            generation += 1
        }
    }
}

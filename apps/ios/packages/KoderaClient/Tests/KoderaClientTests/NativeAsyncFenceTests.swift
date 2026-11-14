import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private enum FenceFixtureError: Error { case uncertainDelivery, deadline }

/// Deliberately ignores cancellation to model native IO completing after a reset's first stop.
private actor SuspendedFenceRadio: ProximityV2RadioTransport {
    private let suspendedBroadcasts: Int
    private let suspendedScans: Int
    private let failFirstBroadcast: Bool
    private var broadcastContinuations: [CheckedContinuation<Void, Never>] = []
    private var scanContinuations: [CheckedContinuation<Void, Never>] = []
    private var observers: [(UUID, Int, Int, Int, CheckedContinuation<Void, Error>)] = []
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private(set) var broadcasts: [ProximityBeaconV2] = []
    private(set) var scanStarts = 0
    private(set) var scanStops = 0
    private(set) var isScanning = false

    init(broadcasts: Int = 0, scans: Int = 0, failFirstBroadcast: Bool = false) {
        suspendedBroadcasts = broadcasts
        suspendedScans = scans
        self.failFirstBroadcast = failFirstBroadcast
    }

    func broadcastBeacon(_ beacon: ProximityBeaconV2, status: ProximitySafetyStatus) async throws {
        broadcasts.append(beacon)
        let index = broadcasts.count
        notifyObservers()
        if index <= suspendedBroadcasts {
            await withCheckedContinuation { broadcastContinuations.append($0) }
        }
        if failFirstBroadcast && index == 1 { throw FenceFixtureError.uncertainDelivery }
    }

    func startScanWindow(durationSeconds: UInt64) async throws {
        scanStarts += 1
        let index = scanStarts
        notifyObservers()
        if index <= suspendedScans {
            await withCheckedContinuation { scanContinuations.append($0) }
        }
        isScanning = true
    }

    func stopScanWindow() async {
        scanStops += 1
        isScanning = false
        notifyObservers()
    }

    func waitFor(broadcasts: Int = 0, starts: Int = 0, stops: Int = 0) async throws {
        if self.broadcasts.count >= broadcasts && scanStarts >= starts && scanStops >= stops { return }
        let id = UUID()
        try await withCheckedThrowingContinuation { continuation in
            observers.append((id, broadcasts, starts, stops, continuation))
            deadlines[id] = Task {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                if let index = observers.firstIndex(where: { $0.0 == id }) {
                    let observer = observers.remove(at: index)
                    deadlines.removeValue(forKey: id)
                    observer.4.resume(throwing: FenceFixtureError.deadline)
                }
            }
        }
    }

    func releaseBroadcasts() {
        let pending = broadcastContinuations
        broadcastContinuations.removeAll()
        for continuation in pending { continuation.resume() }
    }

    func releaseScans() {
        let pending = scanContinuations
        scanContinuations.removeAll()
        for continuation in pending { continuation.resume() }
    }

    private func notifyObservers() {
        var waiting: [(UUID, Int, Int, Int, CheckedContinuation<Void, Error>)] = []
        for observer in observers {
            if broadcasts.count >= observer.1 && scanStarts >= observer.2 && scanStops >= observer.3 {
                deadlines.removeValue(forKey: observer.0)?.cancel()
                observer.4.resume()
            } else { waiting.append(observer) }
        }
        observers = waiting
    }
}

private actor FenceCallResolver: AuthenticatedCallStateResolver {
    func resolveEncryptedCall(wakeup: IncomingCallWakeup) async throws -> VerifiedCallDescriptor {
        try VerifiedCallDescriptor(wakeupId: wakeup.wakeupId, organisationId: wakeup.organisationId,
                                  roomId: "!synthetic:community.kodera.io", liveKitRoomName: "synthetic_room",
                                  callerLabel: "Synthetic authenticated caller", hasVideo: false)
    }
}

/// The first report becomes visible only after release, even if it was already ended during reset.
private actor SuspendedFenceCallProvider: SystemCallProviderControlling {
    private var firstReport: CheckedContinuation<Void, Never>?
    private var enteredObservers: [CheckedContinuation<Void, Never>] = []
    private let failFirstReport: Bool
    private(set) var reports: [UUID] = []
    private(set) var ended: [UUID] = []
    private(set) var visible: Set<UUID> = []

    init(failFirstReport: Bool = false) { self.failFirstReport = failFirstReport }

    func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws {
        reports.append(uuid)
        let index = reports.count
        if index == 1 {
            let observers = enteredObservers
            enteredObservers.removeAll()
            for observer in observers { observer.resume() }
            await withCheckedContinuation { firstReport = $0 }
        }
        visible.insert(uuid)
        if index == 1 && failFirstReport { throw FenceFixtureError.uncertainDelivery }
    }

    func waitForFirstReport() async {
        if !reports.isEmpty { return }
        await withCheckedContinuation { enteredObservers.append($0) }
    }

    func releaseFirstReport() { firstReport?.resume(); firstReport = nil }
    func reportConnecting(uuid: UUID) async {}
    func reportConnected(uuid: UUID) async {}
    func reportCallEnded(uuid: UUID, reason: CallEndReason) async { ended.append(uuid); visible.remove(uuid) }
}

@MainActor
final class NativeAsyncFenceTests: XCTestCase {
    private let orgA = "11111111-1111-4111-8111-111111111111"
    private let orgB = "22222222-2222-4222-8222-222222222222"
    private let wakeupA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let wakeupB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    private func provisioning(_ org: String, radio: SuspendedFenceRadio) throws -> ProximityV2RadioProvisioning {
        let key = Data((1...32).map(UInt8.init))
        return try ProximityV2RadioProvisioning(organisationId: org,
            sender: ProximityBeaconV2Sender(organisationId: org, discoveryKey: key, deviceSeed: Data((33...64).map(UInt8.init))),
            receiver: ProximityBeaconV2Receiver(organisationId: org, discoveryKey: key), transport: radio)
    }

    private func controller(_ radio: SuspendedFenceRadio, broadcasts: Int = 2) throws -> ProximityV2CheckInController {
        let budget = try ProximityDutyCycleBudget(minimumBatteryPercent: 15, maxScanWindowSeconds: 10,
                                                  minCooldownSeconds: 50, maxBroadcastsPerRotationWindow: broadcasts)
        let controller = ProximityV2CheckInController(budget: budget)
        controller.configure(organisationId: orgA, provisioning: try provisioning(orgA, radio: radio))
        try controller.grantForegroundConsent(forOrganisationId: orgA)
        return controller
    }

    func testConcurrentEmitsReserveUniqueSequenceAndBudgetBeforeAwait() async throws {
        let radio = SuspendedFenceRadio(broadcasts: 2)
        let controller = try controller(radio)
        let first = Task { try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 600) }
        try await radio.waitFor(broadcasts: 1)
        let second = Task { try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 601) }
        try await radio.waitFor(broadcasts: 2)
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 602)
            XCTFail("Reserved broadcasts must exhaust the current window budget")
        } catch { XCTAssertEqual(error as? ProximityBeaconV2Error, .dutyCycleThrottled) }
        let packets = await radio.broadcasts
        XCTAssertEqual(packets.map(\.sequence), [0, 1])
        await radio.releaseBroadcasts()
        _ = try await first.value
        _ = try await second.value
        XCTAssertEqual(controller.verifiedLocalBroadcastCount, 2)
    }

    func testUncertainBroadcastFailureNeverRefundsSequenceOrDutyBudget() async throws {
        let radio = SuspendedFenceRadio(failFirstBroadcast: true)
        let controller = try controller(radio)
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 600)
            XCTFail("Synthetic post-transmission failure required")
        } catch { XCTAssertTrue(error is FenceFixtureError) }
        let retry = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 601)
        XCTAssertEqual(retry.sequence, 1)
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 602)
            XCTFail("Uncertain transmission still consumes duty budget")
        } catch { XCTAssertEqual(error as? ProximityBeaconV2Error, .dutyCycleThrottled) }
    }

    func testConcurrentScanIntentRefusesEvenWhenSecondClockWouldPassCooldown() async throws {
        let radio = SuspendedFenceRadio(scans: 1)
        let controller = try controller(radio)
        let first = Task { try await controller.startScanWindow(nowUnixSeconds: 600) }
        try await radio.waitFor(starts: 1)
        do {
            try await controller.startScanWindow(nowUnixSeconds: 660)
            XCTFail("An unresolved native start cannot admit a second scan intent")
        } catch { XCTAssertEqual(error as? ProximityBeaconV2Error, .dutyCycleThrottled) }
        let starts = await radio.scanStarts
        XCTAssertEqual(starts, 1)
        await radio.releaseScans()
        try await first.value
    }

    func testSwitchRetiresLateOldStartBeforeReusingRadioForNewWindow() async throws {
        let radio = SuspendedFenceRadio(scans: 1)
        let controller = try controller(radio)
        let old = Task { try await controller.startScanWindow(nowUnixSeconds: 600) }
        try await radio.waitFor(starts: 1)
        controller.configure(organisationId: orgB, provisioning: try provisioning(orgB, radio: radio))
        try controller.grantForegroundConsent(forOrganisationId: orgB)
        let replacement = Task { try await controller.startScanWindow(nowUnixSeconds: 660) }
        try await radio.waitFor(stops: 1)
        let startsBeforeRetirement = await radio.scanStarts
        XCTAssertEqual(startsBeforeRetirement, 1)
        await radio.releaseScans()
        do { try await old.value; XCTFail("Old generation must refuse") }
        catch { XCTAssertEqual(error as? ProximityBeaconV2Error, .foregroundConsentRequired) }
        try await replacement.value
        let scanning = await radio.isScanning
        let stops = await radio.scanStops
        XCTAssertTrue(scanning, "Old cleanup must not stop the replacement scan")
        XCTAssertEqual(stops, 2)
    }

    func testSignoutRetiresLateOldScanAndNeverRestoresRadioState() async throws {
        let radio = SuspendedFenceRadio(scans: 1)
        let controller = try controller(radio)
        let old = Task { try await controller.startScanWindow(nowUnixSeconds: 600) }
        try await radio.waitFor(starts: 1)
        controller.configure(organisationId: nil)
        try await radio.waitFor(stops: 1)
        await radio.releaseScans()
        do { try await old.value; XCTFail("Signed-out start must refuse") }
        catch { XCTAssertEqual(error as? ProximityBeaconV2Error, .foregroundConsentRequired) }
        try await radio.waitFor(stops: 2)
        let scanning = await radio.isScanning
        XCTAssertFalse(scanning)
        XCTAssertNil(controller.organisationId)
        XCTAssertEqual(controller.localRadioStatus, .unprovisioned)
    }

    func testCompletedActiveScanStopsOnOrganisationSwitchAndSignout() async throws {
        let radio = SuspendedFenceRadio()
        let controller = try controller(radio)
        try await controller.startScanWindow(nowUnixSeconds: 600)
        controller.configure(organisationId: orgB, provisioning: try provisioning(orgB, radio: radio))
        try await radio.waitFor(stops: 1)
        try controller.grantForegroundConsent(forOrganisationId: orgB)
        try await controller.startScanWindow(nowUnixSeconds: 660)
        controller.configure(organisationId: nil)
        try await radio.waitFor(stops: 2)
        let scanning = await radio.isScanning
        XCTAssertFalse(scanning)
    }

    private func push(_ id: String, org: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["wakeup_id": id, "organisation_id": org, "sync_hint": "synthetic_sync"])
    }

    private func checkLateReport(fails: Bool) async throws {
        let provider = SuspendedFenceCallProvider(failFirstReport: fails)
        let coordinator = try CallKitPushCoordinator(organisationId: orgA, resolver: FenceCallResolver(), systemProvider: provider)
        let oldPayload = try push(wakeupA, org: orgA)
        let old = Task { await coordinator.handleIncomingPushData(oldPayload) }
        await provider.waitForFirstReport()
        try await coordinator.switchOrganisation(orgB)
        let current = await coordinator.handleIncomingPushData(try push(wakeupB, org: orgB))
        guard case .success = current else { return XCTFail("Replacement call must be admitted") }
        await provider.releaseFirstReport()
        let stale = await old.value
        XCTAssertEqual(stale, .failure(.organisationMismatch))
        XCTAssertEqual(coordinator.state.activeCallUUID, UUID(uuidString: wakeupB))
        let visible = await provider.visible
        let ended = await provider.ended
        XCTAssertEqual(visible, [UUID(uuidString: wakeupB)!])
        XCTAssertFalse(ended.contains(UUID(uuidString: wakeupB)!))
    }

    func testStaleNativeCallSuccessEndsOnlyOldUUIDAndPreservesReplacement() async throws {
        try await checkLateReport(fails: false)
    }

    func testStaleNativeCallFailureCannotOverwriteReplacementState() async throws {
        try await checkLateReport(fails: true)
    }

    func testLateNativeReportAfterStopIsEndedAndNeverReturnsSuccess() async throws {
        let provider = SuspendedFenceCallProvider()
        let coordinator = try CallKitPushCoordinator(organisationId: orgA, resolver: FenceCallResolver(), systemProvider: provider)
        let payload = try push(wakeupA, org: orgA)
        let old = Task { await coordinator.handleIncomingPushData(payload) }
        await provider.waitForFirstReport()
        await coordinator.stop()
        await provider.releaseFirstReport()
        let stale = await old.value
        XCTAssertEqual(stale, .failure(.organisationMismatch))
        let visible = await provider.visible
        XCTAssertTrue(visible.isEmpty)
        XCTAssertTrue(coordinator.isStopped)
        XCTAssertNil(coordinator.state.organisationId)
    }

    func testPendingNativeUUIDCannotBeReusedUntilOldReportCleanupCompletes() async throws {
        let provider = SuspendedFenceCallProvider()
        let coordinator = try CallKitPushCoordinator(organisationId: orgA, resolver: FenceCallResolver(), systemProvider: provider)
        let payload = try push(wakeupA, org: orgA)
        let old = Task { await coordinator.handleIncomingPushData(payload) }
        await provider.waitForFirstReport()
        try await coordinator.switchOrganisation(orgB)
        let replacementPayload = try push(wakeupA, org: orgB)
        let refused = await coordinator.handleIncomingPushData(replacementPayload)
        XCTAssertEqual(refused, .failure(.invalidTransition))
        await provider.releaseFirstReport()
        _ = await old.value
        let admitted = await coordinator.handleIncomingPushData(replacementPayload)
        guard case .success = admitted else { return XCTFail("UUID can be reused after exact old report retirement") }
        let visible = await provider.visible
        XCTAssertEqual(visible, [UUID(uuidString: wakeupA)!])
    }
}

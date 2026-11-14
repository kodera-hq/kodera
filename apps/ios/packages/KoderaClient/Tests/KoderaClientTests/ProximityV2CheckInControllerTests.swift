import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private actor RecordingProximityV2Radio: ProximityV2RadioTransport {
    private(set) var scanStarts: [UInt64] = []
    private(set) var scanStops = 0
    private(set) var broadcasts: [(ProximityBeaconV2, ProximitySafetyStatus)] = []

    func startScanWindow(durationSeconds: UInt64) async throws {
        scanStarts.append(durationSeconds)
    }

    func stopScanWindow() async {
        scanStops += 1
    }

    func broadcastBeacon(_ beacon: ProximityBeaconV2, status: ProximitySafetyStatus) async throws {
        broadcasts.append((beacon, status))
    }
}

@MainActor
final class ProximityV2CheckInControllerTests: XCTestCase {
    private let orgA = "11111111-1111-4111-8111-111111111111"
    private let orgB = "22222222-2222-4222-8222-222222222222"

    private func makeProvisioning(
        organisationId: String,
        radio: RecordingProximityV2Radio
    ) throws -> (ProximityV2RadioProvisioning, Data) {
        let discoveryKey = Data((1...32).map(UInt8.init))
        let localSeed = Data((33...64).map(UInt8.init))
        let sender = try ProximityBeaconV2Sender(
            organisationId: organisationId,
            discoveryKey: discoveryKey,
            deviceSeed: localSeed
        )
        let receiver = try ProximityBeaconV2Receiver(
            organisationId: organisationId,
            discoveryKey: discoveryKey,
            capacity: 64
        )
        let provisioning = try ProximityV2RadioProvisioning(
            organisationId: organisationId,
            sender: sender,
            receiver: receiver,
            transport: radio
        )
        return (provisioning, discoveryKey)
    }

    func testRequiresExplicitForegroundConsentAndSuspendsOnBackgroundOrOrganisationSwitch() async throws {
        let radio = RecordingProximityV2Radio()
        let (provisioning, discoveryKey) = try makeProvisioning(organisationId: orgA, radio: radio)
        let controller = ProximityV2CheckInController()

        controller.configure(
            organisationId: orgA,
            provisioning: provisioning,
            onlineMatrixRoomId: "!proximity:community.kodera.io"
        )
        XCTAssertEqual(
            controller.onlineMatrixRelayStatus,
            .connectedRoom(roomId: "!proximity:community.kodera.io")
        )
        XCTAssertEqual(controller.localRadioStatus, .awaitingForegroundConsent)
        XCTAssertFalse(controller.hasVerifiedLocalRadioDelivery)

        // Without explicit foreground opt-in, neither scanning nor radio check-in emission is permitted.
        do {
            try await controller.startScanWindow(nowUnixSeconds: 600)
            XCTFail("Expected foregroundConsentRequired")
        } catch let error as ProximityBeaconV2Error {
            XCTAssertEqual(error, .foregroundConsentRequired)
        }

        // Preparing a local draft never claims verified local BLE delivery.
        XCTAssertTrue(controller.prepareDraft(.safe))
        XCTAssertEqual(controller.draft.status, .safe)
        XCTAssertFalse(controller.hasVerifiedLocalRadioDelivery)

        // Granting foreground consent enables bounded scanning and v2 beacon emission.
        try controller.grantForegroundConsent(forOrganisationId: orgA)
        XCTAssertEqual(controller.localRadioStatus, .readyForLocalRadio)

        try await controller.startScanWindow(nowUnixSeconds: 600)
        XCTAssertEqual(
            controller.localRadioStatus,
            .scanningWindowActive(startedAtUnixSeconds: 600, expiresAtUnixSeconds: 610)
        )

        let emitted = try await controller.emitCheckInOverLocalRadio(status: .needAssistance, nowUnixSeconds: 602)
        XCTAssertEqual(emitted.bytes.count, ProximityBeaconV2.wireByteCount)
        XCTAssertTrue(controller.hasVerifiedLocalRadioDelivery)
        XCTAssertEqual(controller.verifiedLocalBroadcastCount, 1)

        // Verify peer v2 beacon ingestion and replay protection.
        var peerSender = try ProximityBeaconV2Sender(
            organisationId: orgA,
            discoveryKey: discoveryKey,
            deviceSeed: Data((65...96).map(UInt8.init))
        )
        let peerBeacon = try peerSender.emit(atUnixSeconds: 603)
        let observation = try controller.ingestObservedPeerBeacon(peerBeacon.bytes, nowUnixSeconds: 603)
        XCTAssertEqual(observation.sequence, 0)
        XCTAssertEqual(controller.verifiedPeerObservations.count, 1)
        XCTAssertThrowsError(try controller.ingestObservedPeerBeacon(peerBeacon.bytes, nowUnixSeconds: 604)) { error in
            XCTAssertEqual(error as? ProximityBeaconV2Error, .replay)
        }

        // Entering background immediately suspends radio activity and blocks emissions.
        controller.setForegroundActive(false)
        XCTAssertEqual(controller.localRadioStatus, .suspendedInBackground)
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 605)
            XCTFail("Expected foregroundConsentRequired while backgrounded")
        } catch let error as ProximityBeaconV2Error {
            XCTAssertEqual(error, .foregroundConsentRequired)
        }

        controller.setForegroundActive(true)
        XCTAssertEqual(controller.localRadioStatus, .readyForLocalRadio)

        // Switching organisations resets consent, peer observations, and verified radio counts.
        controller.configure(organisationId: orgB, provisioning: nil, onlineMatrixRoomId: nil)
        XCTAssertFalse(controller.hasForegroundConsent)
        XCTAssertFalse(controller.hasVerifiedLocalRadioDelivery)
        XCTAssertTrue(controller.verifiedPeerObservations.isEmpty)
        XCTAssertEqual(controller.onlineMatrixRelayStatus, .disconnected)
        XCTAssertEqual(controller.localRadioStatus, .awaitingForegroundConsent)
    }

    func testEnforcesDutyCycleCooldownAndBatteryFloor() async throws {
        let radio = RecordingProximityV2Radio()
        let (provisioning, _) = try makeProvisioning(organisationId: orgA, radio: radio)
        let budget = try ProximityDutyCycleBudget(
            minimumBatteryPercent: 20,
            maxScanWindowSeconds: 10,
            minCooldownSeconds: 50,
            maxBroadcastsPerRotationWindow: 2
        )
        let controller = ProximityV2CheckInController(battery: .nominal, budget: budget)
        controller.configure(organisationId: orgA, provisioning: provisioning)
        try controller.grantForegroundConsent(forOrganisationId: orgA)

        // Scan cooldown: second scan before 60s (10s window + 50s cooldown) is throttled.
        try await controller.startScanWindow(nowUnixSeconds: 1_200)
        do {
            try await controller.startScanWindow(nowUnixSeconds: 1_230)
            XCTFail("Expected dutyCycleThrottled")
        } catch let error as ProximityBeaconV2Error {
            XCTAssertEqual(error, .dutyCycleThrottled)
        }
        try await controller.startScanWindow(nowUnixSeconds: 1_260)

        // Broadcast budget: max 2 broadcasts in a single 300s rotation window.
        _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 1_261)
        _ = try await controller.emitCheckInOverLocalRadio(status: .musterPoint, nowUnixSeconds: 1_262)
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 1_263)
            XCTFail("Expected dutyCycleThrottled on 3rd emission in same window")
        } catch let error as ProximityBeaconV2Error {
            XCTAssertEqual(error, .dutyCycleThrottled)
        }

        // Next 300s rotation window resets the emission budget, unless Low Power Mode is active.
        _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 1_505)
        XCTAssertEqual(controller.verifiedLocalBroadcastCount, 3)

        let lowPower = try ProximityBatterySnapshot(levelPercent: 75, isCharging: false, isLowPowerModeEnabled: true)
        controller.updateBattery(lowPower)
        XCTAssertEqual(controller.localRadioStatus, .throttled(.batteryBudgetExceeded))
        do {
            _ = try await controller.emitCheckInOverLocalRadio(status: .safe, nowUnixSeconds: 1_510)
            XCTFail("Expected batteryBudgetExceeded")
        } catch let error as ProximityBeaconV2Error {
            XCTAssertEqual(error, .batteryBudgetExceeded)
        }
    }
}

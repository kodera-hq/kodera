import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

@MainActor
private final class MockGattDriver: ProximityGattRadioDriver {
    var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)?
    private(set) var advertisedTokens: [Data] = []
    private(set) var stopCount = 0

    func startAdvertisingAndScanning(ephemeralToken: Data) throws {
        advertisedTokens.append(ephemeralToken)
    }

    func stopAll() {
        stopCount += 1
    }
}

@MainActor
private final class MockBonjourDriver: ProximityBonjourLanDriver {
    var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)?
    private(set) var advertisedRecords: [[String: String]] = []
    private(set) var advertisedPorts: [UInt16] = []
    private(set) var stopCount = 0

    func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws {
        advertisedRecords.append(txtRecord)
        advertisedPorts.append(quicPort)
    }

    func stopAll() {
        stopCount += 1
    }
}

@MainActor
final class CoreBluetoothBonjourProximityAdapterTests: XCTestCase {
    private let orgId = "01950000-0000-7000-8000-0000000000a1"
    private let masterKey = Data((1...32).map(UInt8.init))
    private let aliceSeed = Data((33...64).map(UInt8.init))
    private let bobSeed = Data((65...96).map(UInt8.init))

    func testConsentGateForegroundAutoStopTtlAndInstantKillSwitch() async throws {
        let gatt = MockGattDriver()
        let bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour, quicPort: 48_443)

        try session.provision(
            organisationId: orgId,
            scopeTag: "salle-b",
            workspaceMasterKey: masterKey,
            deviceSeed: aliceSeed
        )

        // Starting without explicit foreground opt-in consent is refused.
        XCTAssertThrowsError(try session.startVoluntarySession(nowUnixSeconds: 1_800_000)) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .foregroundConsentRequired)
        }
        XCTAssertEqual(gatt.advertisedTokens.count, 0)

        try session.grantForegroundConsent()
        session.selectedDuration = .hour1
        session.statusNote = "Salle B · café"
        try session.startVoluntarySession(nowUnixSeconds: 1_800_000)

        XCTAssertTrue(session.isSessionActive)
        XCTAssertEqual(session.expiresAtUnixSeconds, 1_800_000 + 3600)
        XCTAssertEqual(gatt.advertisedTokens.count, 1)
        XCTAssertEqual(bonjour.advertisedRecords.count, 1)
        XCTAssertEqual(bonjour.advertisedRecords[0]["alpn"], "kodera-prox/1")

        // Peer Bob emits a rotating HKDF token in the same 15-minute epoch over BLE and Bonjour LAN.
        let bobToken0 = try EphemeralHkdfTokenCodec.mint(
            organisationId: orgId,
            scopeTag: "salle-b",
            workspaceMasterKey: masterKey,
            deviceSeed: bobSeed,
            nowUnixSeconds: 1_800_005,
            counter: 0
        )
        let blePeer = try session.ingestBleObservation(
            tokenData: bobToken0.raw,
            rssiDbm: -52,
            peerNote: "Open space",
            nowUnixSeconds: 1_800_005
        )
        XCTAssertEqual(blePeer.distanceBand, .immediate)
        XCTAssertFalse(blePeer.viaBonjourLan)

        // Replaying the exact same BLE token is rejected.
        XCTAssertThrowsError(
            try session.ingestBleObservation(tokenData: bobToken0.raw, rssiDbm: -52, nowUnixSeconds: 1_800_006)
        ) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .replayRejected)
        }

        // Next counter over Bonjour `_kodera-prox._udp` enriches peer with LAN flag and holds hysteresis at -59 dBm.
        let bobToken1 = try EphemeralHkdfTokenCodec.mint(
            organisationId: orgId,
            scopeTag: "salle-b",
            workspaceMasterKey: masterKey,
            deviceSeed: bobSeed,
            nowUnixSeconds: 1_800_010,
            counter: 1
        )
        let bobTxt = try BonjourProximityTxtCodec.Record(epoch: bobToken1.epoch, token: bobToken1.raw, quicPort: 48_443)
        let lanPeer = try session.ingestBonjourTxtObservation(
            entries: bobTxt.toDictionary(),
            nowUnixSeconds: 1_800_010
        )
        XCTAssertTrue(lanPeer.viaBonjourLan)
        XCTAssertEqual(lanPeer.distanceBand, .immediate)

        // Background auto-stop timer immediately halts GATT + Bonjour and clears active peer list.
        session.handleSceneForegroundChange(isActive: false, backgroundGraceNanoseconds: 10_000_000)
        try await Task.sleep(nanoseconds: 40_000_000)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertTrue(session.peers.isEmpty)
        XCTAssertGreaterThanOrEqual(gatt.stopCount, 1)
        XCTAssertGreaterThanOrEqual(bonjour.stopCount, 1)

        // Resume foreground, restart 15-min session, then trigger instant kill-switch (`leaveProximity`).
        session.handleSceneForegroundChange(isActive: true)
        session.selectedDuration = .minutes15
        try session.startVoluntarySession(nowUnixSeconds: 1_800_100)
        XCTAssertTrue(session.isSessionActive)

        session.leaveProximity()
        XCTAssertFalse(session.isSessionActive)
        XCTAssertFalse(session.hasForegroundConsent)
        XCTAssertNil(session.activeTokenHex)
    }

    func testBonjourTxtRejectsGpsCoordinatesAndRssiHysteresisRejects127Sentinel() throws {
        var classifier = ProximityRssiHysteresisClassifier()
        XCTAssertThrowsError(try classifier.observe(rssiDbm: 127)) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .invalidRssi)
        }
        XCTAssertEqual(try classifier.observe(rssiDbm: -53), .immediate)
        // Hysteresis holds Immediate at -58 dBm (`>= -61`), then demotes to Near at -63 dBm.
        XCTAssertEqual(try classifier.observe(rssiDbm: -58), .immediate)
        XCTAssertEqual(try classifier.observe(rssiDbm: -63), .near)

        // Any coordinate field in Bonjour TXT is strictly refused.
        let token = try EphemeralHkdfTokenCodec.mint(
            organisationId: orgId,
            workspaceMasterKey: masterKey,
            deviceSeed: aliceSeed,
            nowUnixSeconds: 1_800_000
        )
        var polluted = try BonjourProximityTxtCodec.Record(epoch: token.epoch, token: token.raw, quicPort: 48_443).toDictionary()
        polluted["latitude"] = "48.8566"
        XCTAssertThrowsError(try BonjourProximityTxtCodec.decode(polluted)) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .forbiddenCoordinateField)
        }
    }
}

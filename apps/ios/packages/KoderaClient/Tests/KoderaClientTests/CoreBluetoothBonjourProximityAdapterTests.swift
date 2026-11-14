import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

@MainActor
private final class MockGattDriver: ProximityGattRadioDriver {
    var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)?
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)?
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
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)?
    private(set) var advertisedRecords: [[String: String]] = []
    private(set) var advertisedPorts: [UInt16] = []
    private(set) var stopCount = 0
    var failNextStart = false

    func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws {
        if failNextStart { throw ProximityRadioAdapterError.bonjourUnavailable }
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

    func testCurrentEpochLeaseMatchesSharedFrozenWireAndCannotAuthorizeFutureEpoch() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/kodera-rs/vectors/proximity-epoch-lease-v1.json"))
        let vector = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let bootstrapData = try JSONSerialization.data(withJSONObject: try XCTUnwrap(vector["bootstrap"]))
        let now = try XCTUnwrap(vector["now_unix_seconds"] as? UInt64)
        let bootstrap = try XCTUnwrap(vector["bootstrap"] as? [String: Any])
        let workspace = try XCTUnwrap(bootstrap["workspace_id"] as? String)
        let material = try CoreProximityClient.decode(bootstrapData, workspaceId: workspace, nowUnixSeconds: now)
        let token = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(
            organisationId: workspace, epoch: material.epoch, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds,
            epochMacKey: material.epochMacKey, deviceSeed: bobSeed, nowUnixSeconds: now, counter: 7
        )
        XCTAssertEqual(token.tokenHex, vector["token_hex"] as? String)
        XCTAssertEqual(try EphemeralHkdfTokenCodec.verifyWithEpochMacKey(raw: token.raw, organisationId: workspace,
            epoch: material.epoch, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds,
            epochMacKey: material.epochMacKey, nowUnixSeconds: now), token)
        XCTAssertThrowsError(try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: workspace,
            epoch: material.epoch, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds,
            epochMacKey: material.epochMacKey, deviceSeed: bobSeed, nowUnixSeconds: material.epochExpiresAtUnixSeconds))
        let forged = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: workspace,
            epoch: material.epoch + 1, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds + 900,
            epochMacKey: material.epochMacKey, deviceSeed: bobSeed, nowUnixSeconds: material.epochExpiresAtUnixSeconds)
        XCTAssertThrowsError(try EphemeralHkdfTokenCodec.verifyWithEpochMacKey(raw: forged.raw, organisationId: workspace,
            epoch: material.epoch + 1, epochExpiresAtUnixSeconds: material.epochExpiresAtUnixSeconds + 900,
            epochMacKey: Data(repeating: 0xcd, count: 32), nowUnixSeconds: material.epochExpiresAtUnixSeconds)) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .authenticationFailed)
        }
    }

    func testEpochCodecRejectsNonCanonicalEventScopesBeforeMintVerifyAndProvision() throws {
        let key = Data(repeating: 0xab, count: 32), now: UInt64 = 1_800_001
        let token = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
            epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900, epochMacKey: key,
            deviceSeed: aliceSeed, nowUnixSeconds: now)
        let session = VoluntaryProximityRadioSession(gattDriver: MockGattDriver(), bonjourDriver: MockBonjourDriver())
        for scope in ["", "_first", "-first", "first space", "évent", "default\n", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
                scopeTag: scope, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
                epochMacKey: key, deviceSeed: aliceSeed, nowUnixSeconds: now))
            XCTAssertThrowsError(try EphemeralHkdfTokenCodec.verifyWithEpochMacKey(raw: token.raw,
                organisationId: orgId, scopeTag: scope, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
                epochMacKey: key, nowUnixSeconds: now))
            XCTAssertThrowsError(try session.provisionEpoch(organisationId: orgId, scopeTag: scope,
                epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900, epochMacKey: key,
                deviceSeed: aliceSeed, nowUnixSeconds: now))
            XCTAssertNil(session.organisationId)
        }
        for scope in ["A", "0._:-Z", String(repeating: "a", count: 64)] {
            let minted = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
                scopeTag: scope, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
                epochMacKey: key, deviceSeed: aliceSeed, nowUnixSeconds: now)
            XCTAssertEqual(try EphemeralHkdfTokenCodec.verifyWithEpochMacKey(raw: minted.raw,
                organisationId: orgId, scopeTag: scope, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
                epochMacKey: key, nowUnixSeconds: now), minted)
        }
    }

    func testOwnBleAndBonjourBeaconsCannotBecomePeersEvenWithAnotherCounter() throws {
        let gatt = MockGattDriver(), bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        let key = Data(repeating: 0xab, count: 32), now: UInt64 = 1_800_001
        try session.provisionEpoch(organisationId: orgId, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
            epochMacKey: key, deviceSeed: aliceSeed, nowUnixSeconds: now)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: now)
        XCTAssertThrowsError(try session.ingestBleObservation(tokenData: gatt.advertisedTokens[0], rssiDbm: -30, nowUnixSeconds: now))
        XCTAssertThrowsError(try session.ingestBonjourTxtObservation(entries: bonjour.advertisedRecords[0], nowUnixSeconds: now))
        let ownCounter = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
            epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900, epochMacKey: key,
            deviceSeed: aliceSeed, nowUnixSeconds: now, counter: 17)
        XCTAssertThrowsError(try session.ingestBleObservation(tokenData: ownCounter.raw, rssiDbm: -30, nowUnixSeconds: now))
        XCTAssertTrue(session.peers.isEmpty)
        let peer = try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
            epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900, epochMacKey: key,
            deviceSeed: bobSeed, nowUnixSeconds: now)
        _ = try session.ingestBleObservation(tokenData: peer.raw, rssiDbm: -65, nowUnixSeconds: now)
        XCTAssertEqual(session.peers.count, 1)
        session.clearProvisioning()
    }

    func testPeerCapacityRefusesNewPseudonymsButKeepsCountersUntilLeaseExpiry() throws {
        let session = VoluntaryProximityRadioSession(gattDriver: MockGattDriver(), bonjourDriver: MockBonjourDriver())
        let key = Data(repeating: 0xab, count: 32), now: UInt64 = 1_800_001
        func seed(_ index: Int) -> Data {
            var value = Data(repeating: 0x55, count: 32)
            value[0] = UInt8(index & 255); value[1] = UInt8(index >> 8)
            return value
        }
        func token(_ index: Int, counter: UInt32 = 0, at: UInt64 = 1_800_001) throws -> Data {
            try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: orgId,
                epoch: UInt32(at / 900), epochExpiresAtUnixSeconds: (at / 900 + 1) * 900,
                epochMacKey: key, deviceSeed: seed(index), nowUnixSeconds: at, counter: counter).raw
        }
        try session.provisionEpoch(organisationId: orgId, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
            epochMacKey: key, deviceSeed: aliceSeed, nowUnixSeconds: now)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: now)
        for index in 0..<256 {
            _ = try session.ingestBleObservation(tokenData: token(index), rssiDbm: -65, nowUnixSeconds: now)
        }
        XCTAssertEqual(session.peers.count, 256)
        let overflow = try token(256)
        XCTAssertThrowsError(try session.ingestBleObservation(tokenData: overflow, rssiDbm: -30, nowUnixSeconds: now))
        let txt = try BonjourProximityTxtCodec.Record(epoch: 2_000, token: overflow, quicPort: 48_443)
        XCTAssertThrowsError(try session.ingestBonjourTxtObservation(entries: txt.toDictionary(), nowUnixSeconds: now))
        _ = try session.ingestBleObservation(tokenData: token(0, counter: 1), rssiDbm: -30, nowUnixSeconds: now)
        XCTAssertEqual(session.peers.count, 256)
        XCTAssertThrowsError(try session.ingestBleObservation(tokenData: token(0), rssiDbm: -30, nowUnixSeconds: now))
        session.evaluateExpiry(nowUnixSeconds: 1_800_900)
        XCTAssertTrue(session.peers.isEmpty)
        try session.provisionEpoch(organisationId: orgId, epoch: 2_001, epochExpiresAtUnixSeconds: 1_801_800,
            epochMacKey: key, deviceSeed: aliceSeed, nowUnixSeconds: 1_800_900)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: 1_800_900)
        _ = try session.ingestBleObservation(tokenData: token(256, at: 1_800_900), rssiDbm: -65, nowUnixSeconds: 1_800_900)
        XCTAssertEqual(session.peers.count, 1)
        session.clearProvisioning()
    }

    func testPreparedLeaseExpiresWithoutStartingRadiosOrRenewingConsent() async throws {
        let gatt = MockGattDriver(), bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        var renewals = 0
        session.onAuthenticatedRebootstrapRequired = { _ in renewals += 1 }
        try session.provisionEpoch(organisationId: orgId, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
            epochMacKey: Data(repeating: 0xab, count: 32), deviceSeed: aliceSeed, nowUnixSeconds: 1_800_899)
        try session.grantForegroundConsent()
        XCTAssertNotNil(session.organisationId)
        try await Task.sleep(nanoseconds: 1_100_000_000)
        XCTAssertNil(session.organisationId)
        XCTAssertFalse(session.hasForegroundConsent)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertTrue(gatt.advertisedTokens.isEmpty)
        XCTAssertTrue(bonjour.advertisedRecords.isEmpty)
        XCTAssertEqual(renewals, 0)
        XCTAssertThrowsError(try session.startVoluntarySession(nowUnixSeconds: 1_800_900))
    }

    func testEpochLeaseExpiryWipesRadiosBeforeAuthenticatedRenewalAndPreservesConsentCap() throws {
        let gatt = MockGattDriver(), bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        var requestedDeadlines: [UInt64] = []
        session.onAuthenticatedRebootstrapRequired = { requestedDeadlines.append($0) }
        try session.provisionEpoch(organisationId: orgId, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
            epochMacKey: Data(repeating: 0xab, count: 32), deviceSeed: aliceSeed, nowUnixSeconds: 1_800_899)
        try session.grantForegroundConsent()
        session.selectedDuration = .hours2
        try session.startVoluntarySession(nowUnixSeconds: 1_800_899)
        let deadline = try XCTUnwrap(session.expiresAtUnixSeconds)
        try session.refreshSession(nowUnixSeconds: 1_800_900)
        XCTAssertEqual(requestedDeadlines, [deadline])
        XCTAssertNil(session.organisationId)
        XCTAssertNil(session.activeTokenHex)
        XCTAssertFalse(session.hasForegroundConsent)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertEqual(gatt.advertisedTokens.count, 1)
        XCTAssertThrowsError(try session.startVoluntarySession(nowUnixSeconds: 1_800_900))
        try session.provisionEpoch(organisationId: orgId, epoch: 2_001, epochExpiresAtUnixSeconds: 1_801_800,
            epochMacKey: Data(repeating: 0xcd, count: 32), deviceSeed: bobSeed, nowUnixSeconds: 1_800_900)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: 1_800_900, consentExpiresAtUnixSeconds: deadline)
        XCTAssertEqual(session.expiresAtUnixSeconds, deadline)
        session.evaluateExpiry(nowUnixSeconds: deadline)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertEqual(requestedDeadlines, [deadline])
    }

    func testBonjourFailureWipesPreparedEpochCapability() throws {
        let gatt = MockGattDriver(), bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        try session.provisionEpoch(organisationId: orgId, epoch: 2_000, epochExpiresAtUnixSeconds: 1_800_900,
            epochMacKey: Data(repeating: 0xab, count: 32), deviceSeed: aliceSeed, nowUnixSeconds: 1_800_001)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: 1_800_001)
        bonjour.onFailure?(.bonjourUnavailable)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertNil(session.organisationId)
        XCTAssertNil(session.activeTokenHex)
        XCTAssertEqual(session.lastError, .bonjourUnavailable)
    }

    func testActiveSessionRotatesBothTransportsWithoutExtendingTtlAndFailsClosed() throws {
        let gatt = MockGattDriver()
        let bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        try session.provision(organisationId: orgId, workspaceMasterKey: masterKey, deviceSeed: aliceSeed)
        try session.grantForegroundConsent()
        session.selectedDuration = .hours2
        let start: UInt64 = 1_800_899
        try session.startVoluntarySession(nowUnixSeconds: start)
        let expiry = session.expiresAtUnixSeconds
        let original = session.activeTokenHex
        try session.refreshSession(nowUnixSeconds: start)
        XCTAssertEqual(gatt.advertisedTokens.count, 1)
        try session.refreshSession(nowUnixSeconds: start + 1)
        XCTAssertEqual(gatt.advertisedTokens.count, 2)
        XCTAssertEqual(bonjour.advertisedRecords.count, 2)
        XCTAssertNotEqual(session.activeTokenHex, original)
        XCTAssertEqual(session.expiresAtUnixSeconds, expiry)
        XCTAssertNoThrow(try EphemeralHkdfTokenCodec.verify(
            raw: gatt.advertisedTokens[1], organisationId: orgId,
            workspaceMasterKey: masterKey, nowUnixSeconds: start + 1
        ))
        bonjour.failNextStart = true
        XCTAssertThrowsError(try session.refreshSession(nowUnixSeconds: start + 901))
        XCTAssertFalse(session.isSessionActive)
        XCTAssertNil(session.activeTokenHex)
        XCTAssertGreaterThan(gatt.stopCount, 0)
        XCTAssertGreaterThan(bonjour.stopCount, 0)
        let count = gatt.advertisedTokens.count
        try session.refreshSession(nowUnixSeconds: start + 1_801)
        XCTAssertEqual(gatt.advertisedTokens.count, count)
        session.leaveProximity()
    }

    func testExpiryPrecedesRotationAndLatePeerAdmission() throws {
        let gatt = MockGattDriver()
        let bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        try session.provision(organisationId: orgId, workspaceMasterKey: masterKey, deviceSeed: aliceSeed)
        try session.grantForegroundConsent()
        session.selectedDuration = .minutes15
        try session.startVoluntarySession(nowUnixSeconds: 1_800_000)
        try session.refreshSession(nowUnixSeconds: 1_800_900)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertFalse(session.hasForegroundConsent)
        XCTAssertEqual(gatt.advertisedTokens.count, 1)
        let late = try EphemeralHkdfTokenCodec.mint(
            organisationId: orgId, workspaceMasterKey: masterKey, deviceSeed: bobSeed,
            nowUnixSeconds: 1_800_900
        )
        XCTAssertThrowsError(try session.ingestBleObservation(
            tokenData: late.raw, rssiDbm: -50, nowUnixSeconds: 1_800_900
        ))
    }

    func testAsynchronousAdvertisingFailureClearsSessionAndBothTransports() throws {
        let gatt = MockGattDriver()
        let bonjour = MockBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)
        try session.provision(organisationId: orgId, workspaceMasterKey: masterKey, deviceSeed: aliceSeed)
        try session.grantForegroundConsent()
        try session.startVoluntarySession(nowUnixSeconds: 1_800_000)
        gatt.onFailure?(.bluetoothUnavailable)
        XCTAssertFalse(session.isSessionActive)
        XCTAssertNil(session.activeTokenHex)
        XCTAssertEqual(session.lastError, .bluetoothUnavailable)
        XCTAssertGreaterThan(gatt.stopCount, 0)
        XCTAssertGreaterThan(bonjour.stopCount, 0)
    }

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
        var oversized = polluted
        oversized["tok"] = String(repeating: "a", count: 100_000)
        XCTAssertThrowsError(try BonjourProximityTxtCodec.decode(oversized))
        var unknown = polluted
        unknown["unexpected"] = "field"
        XCTAssertThrowsError(try BonjourProximityTxtCodec.decode(unknown))
        polluted["latitude"] = "48.8566"
        XCTAssertThrowsError(try BonjourProximityTxtCodec.decode(polluted)) { error in
            XCTAssertEqual(error as? ProximityRadioAdapterError, .forbiddenCoordinateField)
        }
    }
}

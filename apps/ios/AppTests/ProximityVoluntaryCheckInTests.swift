import Foundation
import SwiftUI
import XCTest
import KoderaClient
import KoderaDomain
@testable import Kodera

@MainActor
private final class HostedTestGattDriver: ProximityGattRadioDriver {
    var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)?
    private(set) var startedTokens: [Data] = []
    private(set) var stopCount = 0

    func startAdvertisingAndScanning(ephemeralToken: Data) throws {
        startedTokens.append(ephemeralToken)
    }

    func stopAll() {
        stopCount += 1
    }
}

@MainActor
private final class HostedTestBonjourDriver: ProximityBonjourLanDriver {
    var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)?
    private(set) var startedTxtRecords: [[String: String]] = []
    private(set) var stopCount = 0

    func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws {
        startedTxtRecords.append(txtRecord)
    }

    func stopAll() {
        stopCount += 1
    }
}

@MainActor
final class ProximityVoluntaryCheckInTests: XCTestCase {
    private let orgId = "11111111-1111-4111-8111-111111111111"
    private let masterKey = Data((0..<32).map { UInt8($0 + 1) })
    private let localSeed = Data((0..<32).map { UInt8($0 + 65) })
    private let peerSeed = Data((0..<32).map { UInt8($0 + 129) })

    func testVoluntaryPresentationKeysResolveLocalizedStringsInAppBundle() {
        let allKeys: [String] = [
            "proximity.voluntary_title",
            "proximity.voluntary_pledge",
            "proximity.voluntary_duration_label",
            ProximityVoluntaryPresentation.durationKey(for: .minutes15),
            ProximityVoluntaryPresentation.durationKey(for: .minutes30),
            ProximityVoluntaryPresentation.durationKey(for: .hour1),
            ProximityVoluntaryPresentation.durationKey(for: .hours2),
            "proximity.voluntary_note_label",
            "proximity.voluntary_note_placeholder",
            "proximity.voluntary_consent_grant",
            "proximity.voluntary_start",
            "proximity.voluntary_leave",
            ProximityVoluntaryPresentation.badgeKey(isSessionActive: true),
            ProximityVoluntaryPresentation.badgeKey(isSessionActive: false),
            "proximity.voluntary_peers_heading",
            "proximity.voluntary_peers_empty",
            ProximityVoluntaryPresentation.distanceBandKey(for: .immediate),
            ProximityVoluntaryPresentation.distanceBandKey(for: .near),
            ProximityVoluntaryPresentation.distanceBandKey(for: .ambient),
            "proximity.voluntary_lan_badge",
            "proximity.voluntary_open_thread",
            "proximity.voluntary_start_call",
        ]

        for key in allKeys {
            let localized = NSLocalizedString(key, comment: "")
            XCTAssertFalse(localized.isEmpty)
            XCTAssertNotEqual(localized, key, "Missing localization in bundle for \(key)")
        }
    }

    func testVoluntaryCheckInViewBindsSessionLifecycleAndPeerCallbacks() throws {
        let gatt = HostedTestGattDriver()
        let bonjour = HostedTestBonjourDriver()
        let session = VoluntaryProximityRadioSession(gattDriver: gatt, bonjourDriver: bonjour)

        try session.provision(
            organisationId: orgId,
            scopeTag: "paris-hub",
            workspaceMasterKey: masterKey,
            deviceSeed: localSeed
        )
        try session.grantForegroundConsent()
        session.selectedDuration = .hour1
        session.statusNote = "Salle B · café"
        try session.startVoluntarySession(nowUnixSeconds: 1_760_000_000)

        XCTAssertTrue(session.isSessionActive)
        XCTAssertEqual(gatt.startedTokens.count, 1)
        XCTAssertEqual(bonjour.startedTxtRecords.count, 1)

        let peerToken = try EphemeralHkdfTokenCodec.mint(
            organisationId: orgId,
            scopeTag: "paris-hub",
            workspaceMasterKey: masterKey,
            deviceSeed: peerSeed,
            nowUnixSeconds: 1_760_000_005,
            counter: 1
        )
        let peer = try session.ingestBleObservation(
            tokenData: peerToken.raw,
            rssiDbm: -48,
            peerNote: "Stand café",
            nowUnixSeconds: 1_760_000_005
        )
        XCTAssertEqual(peer.distanceBand, .immediate)

        var openedThreadPeerId: String?
        var startedCallPeerId: String?
        let view = ProximityVoluntaryCheckInView(
            session: session,
            onOpenEphemeralThread: { openedThreadPeerId = $0.id },
            onStartDirectCall: { startedCallPeerId = $0.id }
        )
        view.onOpenEphemeralThread?(peer)
        view.onStartDirectCall?(peer)
        XCTAssertEqual(openedThreadPeerId, peer.id)
        XCTAssertEqual(startedCallPeerId, peer.id)

        session.leaveProximity()
        XCTAssertFalse(session.isSessionActive)
        XCTAssertTrue(session.peers.isEmpty)
        XCTAssertEqual(gatt.stopCount, 1)
        XCTAssertEqual(bonjour.stopCount, 1)
    }
}

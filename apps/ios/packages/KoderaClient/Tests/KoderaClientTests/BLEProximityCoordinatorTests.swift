import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient
#if canImport(CryptoKit)
import CryptoKit

private actor RecordingProximityTransport: BLEProximityTransport {
    enum Failure: Error { case unavailable }
    private(set) var frames: [Data] = []
    var fail = false
    func setFailure(_ enabled: Bool) { fail = enabled }
    func broadcast(frame: Data, beacon: Data) throws {
        if fail { throw Failure.unavailable }
        frames.append(frame)
    }
    func recorded() -> [Data] { frames }
}

private actor SuspendedProximityTransport: BLEProximityTransport {
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var completion: CheckedContinuation<Void, any Error>?
    func broadcast(frame: Data, beacon: Data) async throws {
        started = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
        try await withCheckedThrowingContinuation { completion = $0 }
    }
    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func fail() {
        completion?.resume(throwing: RecordingProximityTransport.Failure.unavailable)
        completion = nil
    }
}

@MainActor
final class BLEProximityCoordinatorTests: XCTestCase {
    private let now: UInt64 = 1_762_520_100
    private let salt = Data(repeating: 0x42, count: 32)
    private func signer() throws -> Ed25519ProximitySigner {
        try Ed25519ProximitySigner(rawPrivateKey: Curve25519.Signing.PrivateKey().rawRepresentation)
    }
    private func id(_ offset: UInt64 = 0) throws -> ProximityMessageID {
        try ProximityMessageID(timestampMilliseconds: now * 1000 + offset,
                               randomness: Data(repeating: 3, count: 10))
    }
    private func coordinator(_ keys: Set<Data>, capacity: Int = 128) throws -> BLEProximityCoordinator {
        try BLEProximityCoordinator(salt: salt, allowedRoster: keys, queueCapacity: capacity)
    }

    func testPriorityBroadcastAndFailureRetainsPendingFrame() async throws {
        let key = try signer(), node = try coordinator([key.publicKey])
        for (index, status) in [ProximitySafetyStatus.safe, .messageOnly, .needAssistance, .musterPoint].enumerated() {
            try await node.createLocalCheckIn(messageID: id(UInt64(index)), status: status, text: "", signer: key)
        }
        let radio = RecordingProximityTransport()
        await radio.setFailure(true)
        do { _ = try await node.broadcastNext(using: radio, unixSeconds: now); XCTFail("failed radio must not consume frame") }
        catch RecordingProximityTransport.Failure.unavailable {}
        let pending = await node.pendingCount
        XCTAssertEqual(pending, 4)
        await radio.setFailure(false)
        for _ in 0..<4 { _ = try await node.broadcastNext(using: radio, unixSeconds: now) }
        let frames = await radio.recorded()
        XCTAssertEqual(try frames.map { try ProximityFrame.decode($0).status }, [.needAssistance, .musterPoint, .safe, .messageOnly])
        let empty = try await node.broadcastNext(using: radio, unixSeconds: now)
        XCTAssertFalse(empty)
    }

    func testMembersAreLabelledWithAnOrganisationBoundPseudonymNeverAName() async throws {
        let key = try signer(), node = try coordinator([key.publicKey])
        let none = try await node.memberLabels()
        XCTAssertTrue(none.isEmpty)
        try await node.createLocalCheckIn(messageID: id(), status: .safe, text: "", signer: key)
        let labels = try await node.memberLabels()
        XCTAssertEqual(labels.count, 1)
        XCTAssertEqual(labels[0].senderPublicKey, key.publicKey)
        XCTAssertEqual(labels[0].handle, try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: key.publicKey))
        XCTAssertEqual(labels[0].handle.origin, .generated)
        XCTAssertNil(labels[0].fingerprint)
        XCTAssertEqual(labels[0].display, labels[0].handle.value)
        XCTAssertTrue(ProximityHandle.isValid(labels[0].handle.value))
        // Another organisation's salt shows another pseudonym for the same key.
        XCTAssertNotEqual(labels[0].handle, try ProximityHandle.generated(
            organisationSalt: Data(repeating: 0x43, count: 32), senderPublicKey: key.publicKey))
    }

    /// A member whose handle equals that of a provisioned member who has not checked in yet is already
    /// shown with its key fingerprint: it cannot pass for the absent member, and its label does not
    /// change when that member appears.
    func testAHandleSharedWithAnAbsentProvisionedMemberAlreadyCarriesItsFingerprint() async throws {
        let first = try signer(), second = try signer(), outsider = try signer()
        let node = try coordinator([first.publicKey, second.publicKey])
        try await node.provisionDedicatedHandle("north-wing-3", for: first.publicKey)
        try await node.provisionDedicatedHandle("north-wing-3", for: second.publicKey)
        try await node.createLocalCheckIn(messageID: id(), status: .safe, text: "", signer: first)
        let alone = try await node.memberLabels()
        XCTAssertEqual(alone.count, 1)
        XCTAssertEqual(alone[0].handle.value, "north-wing-3")
        XCTAssertEqual(alone[0].handle.origin, .dedicated)
        let fingerprint = try XCTUnwrap(alone[0].fingerprint, "the handle is shared with a member that has not checked in")
        // Keyed with this organisation's beacon salt: the same key elsewhere shows another one.
        XCTAssertTrue(try ProximityHandle.fingerprint(organisationSalt: salt, senderPublicKey: first.publicKey).hasPrefix(fingerprint))
        XCTAssertFalse(try ProximityHandle.fingerprint(organisationSalt: Data(repeating: 0x43, count: 32),
                                                       senderPublicKey: first.publicKey).hasPrefix(fingerprint))
        XCTAssertEqual(alone[0].display, "north-wing-3 [\(fingerprint)]")

        try await node.createLocalCheckIn(messageID: id(1), status: .safe, text: "", signer: second)
        let both = try await node.memberLabels()
        XCTAssertEqual(both.count, 2)
        XCTAssertTrue(both.contains(alone[0]), "the first label is unchanged when the other member appears")
        XCTAssertEqual(Set(both.map(\.display)).count, 2)

        // Provisioning a pseudonym is display metadata for roster keys only.
        do { try await node.provisionDedicatedHandle("north-wing-3", for: outsider.publicKey); XCTFail("an outsider was labelled") }
        catch { XCTAssertEqual(error as? ProximityError, .unauthorizedSender) }
        do { try await node.provisionDedicatedHandle("North Wing", for: first.publicKey); XCTFail("a display name was admitted") }
        catch { XCTAssertEqual(error as? ProximityError, .invalidHandle) }
        await node.stop()
        do { _ = try await node.memberLabels(); XCTFail("a stopped node labelled members") }
        catch { XCTAssertEqual(error as? ProximityError, .invalidConfiguration) }
    }

    func testMultiHopStopsAtOneWithoutBreakingSignature() async throws {
        let key = try signer(), roster: Set<Data> = [key.publicKey]
        let original = try ProximityFrame.signed(messageID: id(), ttlHops: 3, status: .safe, text: "", signer: key)
        let beacon = try ProximityBeacon.compute(salt: salt, unixSeconds: now)
        var wire = original.encode()
        for expected in [2, 1] as [UInt8] {
            let node = try coordinator(roster)
            try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: wire)
            let radio = RecordingProximityTransport()
            _ = try await node.broadcastNext(using: radio, unixSeconds: now)
            let sent = await radio.recorded()
            XCTAssertEqual(sent.count, 1)
            let relayed = try ProximityFrame.decode(sent[0])
            XCTAssertEqual(relayed.ttlHops, expected)
            XCTAssertNoThrow(try relayed.verified(allowedRoster: roster))
            wire = sent[0]
        }
        let last = try coordinator(roster)
        try await last.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: wire)
        let pending = await last.pendingCount, members = await last.memberStatuses()
        XCTAssertEqual(pending, 0); XCTAssertEqual(members.count, 1)
        XCTAssertEqual(members[0].ttlHops, 1)
    }

    func testTamperedUnauthorizedWrongBeaconAndReplayCannotChangeState() async throws {
        let key = try signer(), outsider = try signer(), node = try coordinator([key.publicKey])
        let good = try ProximityFrame.signed(messageID: id(), ttlHops: 3, status: .safe, text: "", signer: key)
        let beacon = try ProximityBeacon.compute(salt: salt, unixSeconds: now)
        let foreign = try ProximityFrame.signed(messageID: id(), ttlHops: 3, status: .safe, text: "", signer: outsider)
        var bad = good.encode(); bad[52] = ProximitySafetyStatus.needAssistance.rawValue
        for (wire, tag, expectedError) in [(good.encode(), Data(repeating: 0, count: 8), ProximityError.wrongBeacon),
                                   (foreign.encode(), beacon, .unauthorizedSender), (bad, beacon, .invalidSignature)] {
            do { try await node.ingestPeerFrame(observedBeacon: tag, unixSeconds: now, rawFrame: wire); XCTFail("refused frame") }
            catch { XCTAssertEqual(error as? ProximityError, expectedError) }
        }
        let before = await node.memberStatuses(), empty = await node.pendingCount
        XCTAssertTrue(before.isEmpty); XCTAssertEqual(empty, 0)
        try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: good.encode())
        do { try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: good.encode()); XCTFail("replay") }
        catch { XCTAssertEqual(error as? ProximityError, .replay) }
        let unchanged = await node.pendingCount
        XCTAssertEqual(unchanged, 1)
    }

    func testFrameDatedPastTheSkewBoundIsRefusedAndCannotMaskRealCheckIns() async throws {
        let key = try signer(), node = try coordinator([key.publicKey])
        let beacon = try ProximityBeacon.compute(salt: salt, unixSeconds: now)
        let ahead = try ProximityFrame.signed(messageID: id(ProximityBounds.maxFutureSkewMilliseconds + 1), ttlHops: 3,
                                              status: .safe, text: "", signer: key)
        do { try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: ahead.encode()); XCTFail("future frame") }
        catch { XCTAssertEqual(error as? ProximityError, .futureFrame) }
        let untouched = await node.memberStatuses()
        XCTAssertTrue(untouched.isEmpty)
        let real = try ProximityFrame.signed(messageID: id(), ttlHops: 3, status: .needAssistance, text: "", signer: key)
        try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: real.encode())
        let atBound = try ProximityFrame.signed(messageID: id(ProximityBounds.maxFutureSkewMilliseconds), ttlHops: 3,
                                                status: .safe, text: "", signer: key)
        try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: atBound.encode())
        let pending = await node.pendingCount
        XCTAssertEqual(pending, 2)
    }

    func testRosterAndQueueFollowTheSharedBounds() throws {
        let roster = Set((0..<ProximityBounds.rosterMembers).map { index in
            Data((0..<32).map { UInt8(truncatingIfNeeded: index >> (($0 % 2) * 8)) ^ UInt8($0) }) })
        XCTAssertEqual(roster.count, ProximityBounds.rosterMembers)
        XCTAssertNoThrow(try BLEProximityCoordinator(salt: salt, allowedRoster: roster, queueCapacity: ProximityBounds.queueCapacity))
        var over = roster; over.insert(Data(repeating: 0xff, count: 32))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: over))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: roster,
                                                         queueCapacity: ProximityBounds.queueCapacity + 1,
                                                         replayCapacity: ProximityBounds.replayEntries))
    }

    func testOutOfOrderCapacityAndStopAreBounded() async throws {
        let key = try signer(), node = try coordinator([key.publicKey], capacity: 1)
        try await node.createLocalCheckIn(messageID: id(2), status: .safe, text: "", signer: key)
        do { try await node.createLocalCheckIn(messageID: id(1), status: .needAssistance, text: "", signer: key); XCTFail("old status") }
        catch { XCTAssertEqual(error as? ProximityError, .staleStatus) }
        do { try await node.createLocalCheckIn(messageID: id(3), status: .messageOnly, text: "", signer: key); XCTFail("full lower-priority queue") }
        catch { XCTAssertEqual(error as? ProximityError, .queueFull) }
        var members = await node.memberStatuses()
        XCTAssertEqual(members[0].messageID, try id(2))
        try await node.createLocalCheckIn(messageID: id(4), status: .needAssistance, text: "", signer: key)
        let count = await node.pendingCount
        XCTAssertEqual(count, 1)
        members = await node.memberStatuses(); XCTAssertEqual(members[0].status, .needAssistance)
        await node.stop()
        let stoppedMembers = await node.memberStatuses(), pending = await node.pendingCount
        XCTAssertTrue(stoppedMembers.isEmpty); XCTAssertEqual(pending, 0)
        do { _ = try await node.currentBeacon(unixSeconds: now); XCTFail("stopped node") }
        catch { XCTAssertEqual(error as? ProximityError, .invalidConfiguration) }
    }

    func testOwnGossipEchoAndPendingDedupSurviveReplayEviction() async throws {
        let key = try signer(), second = try signer(), third = try signer()
        let node = try BLEProximityCoordinator(salt: salt,
            allowedRoster: [key.publicKey, second.publicKey, third.publicKey], queueCapacity: 1, replayCapacity: 1)
        let local = try await node.createLocalCheckIn(messageID: id(1), status: .needAssistance, text: "", signer: key)
        let beacon = try ProximityBeacon.compute(salt: salt, unixSeconds: now)
        do { try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: local.encode()); XCTFail("own echo") }
        catch { XCTAssertEqual(error as? ProximityError, .replay) }
        let evict = try ProximityFrame.signed(messageID: id(2), ttlHops: 1, status: .safe, text: "", signer: second)
        try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: evict.encode())
        let collision = try ProximityFrame.signed(messageID: id(1), ttlHops: 3, status: .needAssistance, text: "", signer: third)
        do { try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: collision.encode()); XCTFail("pending duplicate after cache eviction") }
        catch { XCTAssertEqual(error as? ProximityError, .replay) }
        let pending = await node.pendingCount, members = await node.memberStatuses()
        XCTAssertEqual(pending, 1); XCTAssertEqual(members.count, 2)
        let wrong = try ProximityBeacon.compute(salt: salt, unixSeconds: now + 600)
        do { try await node.ingestPeerFrame(observedBeacon: wrong, unixSeconds: now, rawFrame: evict.encode()); XCTFail("outside beacon tolerance") }
        catch { XCTAssertEqual(error as? ProximityError, .wrongBeacon) }
    }

    func testFullRelayQueueStillAcceptsLatestVerifiedPeerStatus() async throws {
        let key = try signer(), node = try coordinator([key.publicKey], capacity: 1)
        try await node.createLocalCheckIn(messageID: id(0), status: .needAssistance, text: "", signer: key)
        let newer = try ProximityFrame.signed(messageID: id(1), ttlHops: 3, status: .safe, text: "", signer: key)
        let beacon = try ProximityBeacon.compute(salt: salt, unixSeconds: now)
        try await node.ingestPeerFrame(observedBeacon: beacon, unixSeconds: now, rawFrame: newer.encode())
        let members = await node.memberStatuses(), count = await node.pendingCount
        XCTAssertEqual(members[0].status, .safe)
        XCTAssertEqual(members[0].messageID, newer.messageID)
        XCTAssertEqual(count, 1)
        let radio = RecordingProximityTransport()
        _ = try await node.broadcastNext(using: radio, unixSeconds: now)
        let frames = await radio.recorded()
        XCTAssertEqual(try ProximityFrame.decode(frames[0]).status, .needAssistance)
    }

    func testSuspendedFailedTransportCannotLosePinnedFrameToPreemption() async throws {
        let key = try signer(), peer = try signer()
        let node = try coordinator([key.publicKey, peer.publicKey], capacity: 1)
        let local = try await node.createLocalCheckIn(messageID: id(0), status: .safe, text: "", signer: key)
        let radio = SuspendedProximityTransport()
        let pending = Task { try await node.broadcastNext(using: radio, unixSeconds: now) }
        await radio.waitUntilStarted()
        do {
            try await node.createLocalCheckIn(messageID: id(1), status: .needAssistance, text: "", signer: peer)
            XCTFail("pinned frame must not be evicted")
        } catch { XCTAssertEqual(error as? ProximityError, .queueFull) }
        let refused = await node.memberStatuses()
        XCTAssertEqual(refused.count, 1)
        let incoming = try ProximityFrame.signed(messageID: id(1), ttlHops: 3, status: .needAssistance, text: "", signer: peer)
        try await node.ingestPeerFrame(observedBeacon: ProximityBeacon.compute(salt: salt, unixSeconds: now), unixSeconds: now, rawFrame: incoming.encode())
        let accepted = await node.memberStatuses(), count = await node.pendingCount
        XCTAssertEqual(accepted.count, 2); XCTAssertEqual(count, 1)
        await radio.fail()
        do { _ = try await pending.value; XCTFail("adapter failed") }
        catch RecordingProximityTransport.Failure.unavailable {}
        let retry = RecordingProximityTransport()
        _ = try await node.broadcastNext(using: retry, unixSeconds: now)
        let frames = await retry.recorded()
        XCTAssertEqual(try ProximityFrame.decode(frames[0]), local)
    }

    func testBeaconAdjacentBucketsAndIntegerEdges() async throws {
        let key = try signer()
        for seconds in [now - 300, now, now + 300] {
            let node = try coordinator([key.publicKey])
            let frame = try ProximityFrame.signed(messageID: id(), ttlHops: 1, status: .safe, text: "", signer: key)
            try await node.ingestPeerFrame(observedBeacon: ProximityBeacon.compute(salt: salt, unixSeconds: seconds), unixSeconds: now, rawFrame: frame.encode())
        }
        for seconds in [UInt64(0), UInt64.max] {
            let node = try coordinator([key.publicKey])
            // A clock at the epoch admits only frames dated within the skew bound of it.
            let messageID = seconds == 0 ? try ProximityMessageID(timestampMilliseconds: 0, randomness: Data(repeating: 3, count: 10)) : try id()
            let frame = try ProximityFrame.signed(messageID: messageID, ttlHops: 1, status: .safe, text: "", signer: key)
            try await node.ingestPeerFrame(observedBeacon: ProximityBeacon.compute(salt: salt, unixSeconds: seconds), unixSeconds: seconds, rawFrame: frame.encode())
        }
    }

    func testDefaultSystemClockAcceptsCurrentFrameAndRefusesFarFutureFrame() async throws {
        let key = try signer(), node = try coordinator([key.publicKey])
        let beacon = try await node.currentBeacon()
        let currentMs = ProximityBounds.currentUnixMilliseconds()
        let present = try ProximityFrame.signed(
            messageID: ProximityMessageID(timestampMilliseconds: currentMs, randomness: Data(repeating: 1, count: 10)),
            ttlHops: 2, status: .safe, text: "", signer: key
        )
        try await node.ingestPeerFrame(observedBeacon: beacon, rawFrame: present.encode())
        let future = try ProximityFrame.signed(
            messageID: ProximityMessageID(
                timestampMilliseconds: currentMs + ProximityBounds.maxFutureSkewMilliseconds + 60_000,
                randomness: Data(repeating: 2, count: 10)
            ),
            ttlHops: 2, status: .safe, text: "", signer: key
        )
        do {
            try await node.ingestPeerFrame(observedBeacon: beacon, rawFrame: future.encode())
            XCTFail("future frame must be refused by default system clock")
        } catch {
            XCTAssertEqual(error as? ProximityError, .futureFrame)
        }
    }
}
#endif

final class ProximityCoordinatorConfigurationTests: XCTestCase {
    func testMissingProvisioningAndUnboundedConfigurationRefused() {
        let validKey = Data(repeating: 1, count: 32), salt = Data(repeating: 2, count: 32)
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: []))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: Data(), allowedRoster: [validKey]))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: [validKey], queueCapacity: 129))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: [validKey], queueCapacity: 2, replayCapacity: 1))
        XCTAssertThrowsError(try BLEProximityCoordinator(salt: salt, allowedRoster: [Data()]))
    }
}

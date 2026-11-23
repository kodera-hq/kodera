import Foundation
import XCTest
@testable import KoderaDomain

final class NativeCallRingTests: XCTestCase {
    private func vectors() throws -> [Substring] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { root.deleteLastPathComponent() }
        return try String(contentsOf: root.appendingPathComponent("packages/kodera-rs/vectors/mobile-call-wake-v1.txt"), encoding: .utf8)
            .split(separator: "\n").filter { !$0.hasPrefix("#") }
    }
    func testSharedStrictWireVectorsThroughPacketBinding() throws {
        for line in try vectors() {
            let parts = line.split(separator: "|", maxSplits: 2)
            let result = try? NativeCallWake.admit(Data(parts[2].utf8), now: UInt64(parts[1])!)
            XCTAssertEqual(result != nil, parts[0] == "1", String(line))
        }
    }
    func testCancellationReorderingClockAndTerminalReplay() throws {
        let line = try vectors()[0].split(separator: "|", maxSplits: 2)
        let ring = try NativeCallWake.admit(Data(line[2].utf8), now: 100)
        var machine = try NativeCallRing(organisationId: ring.organisationId)
        let cancel = try NativeCallWake(callId: ring.callId, organisationId: ring.organisationId, channelId: ring.channelId, epoch: 2, state: .answeredElsewhere, expiresAt: 130)
        try machine.observe(cancel, now: 100)
        XCTAssertThrowsError(try machine.observe(ring, now: 101))
        XCTAssertEqual(machine.records[ring.callId]?.phase, .answeredElsewhere)
        XCTAssertEqual(machine.records[ring.callId]?.missed, false)
        machine.revoke(); XCTAssertTrue(machine.records.isEmpty)
        try machine.observe(ring, now: 101)
        XCTAssertThrowsError(try machine.observe(cancel, now: 100))
        try machine.transition(callId: ring.callId, to: .connecting)
        try machine.transition(callId: ring.callId, to: .connected)
        machine.tick(now: 140)
        XCTAssertEqual(machine.records[ring.callId]?.phase, .connected)
    }
    func testDelayedAnswerClearsExpiredMissedState() throws {
        let parts = try vectors()[0].split(separator: "|", maxSplits: 2)
        let wake = try NativeCallWake.admit(Data(parts[2].utf8), now: 100)
        var machine = try NativeCallRing(organisationId: wake.organisationId)
        try machine.observe(wake, now: 100); machine.tick(now: 130)
        XCTAssertEqual(machine.records[wake.callId]?.missed, true)
        let cancel = try NativeCallWake(callId: wake.callId, organisationId: wake.organisationId, channelId: wake.channelId, epoch: 2, state: .answeredElsewhere, expiresAt: 150)
        try machine.observe(cancel, now: 131)
        XCTAssertEqual(machine.records[wake.callId]?.phase, .answeredElsewhere)
        XCTAssertEqual(machine.records[wake.callId]?.missed, false)
    }
    func testCapacityPreservesCancellationTombstones() throws {
        let org = "22222222-2222-4222-8222-222222222222"
        var machine = try NativeCallRing(organisationId: org)
        for i in 1...128 {
            let id = String(format: "11111111-1111-4111-8111-%012x", i)
            try machine.observe(NativeCallWake(callId: id, organisationId: org, channelId: org, epoch: 1, state: .ended, expiresAt: 130), now: 100)
        }
        XCTAssertThrowsError(try machine.observe(NativeCallWake(callId: org, organisationId: org, channelId: org, epoch: 1, state: .ended, expiresAt: 130), now: 100))
        XCTAssertEqual(machine.records.count, 128)
    }
}

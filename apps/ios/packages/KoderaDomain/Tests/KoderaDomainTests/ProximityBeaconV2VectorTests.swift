import Foundation
import XCTest
@testable import KoderaDomain

/// Holds `ProximityBeaconV2` byte-for-byte to `packages/kodera-rs/vectors/proximity-beacon-v2.txt`.
final class ProximityBeaconV2VectorTests: XCTestCase {
    private func decodeHex(_ hex: String) throws -> Data {
        XCTAssertEqual(hex.count % 2, 0)
        return Data(try stride(from: 0, to: hex.count, by: 2).map { index in
            let start = hex.index(hex.startIndex, offsetBy: index)
            return try XCTUnwrap(UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16))
        })
    }

    private func sharedVectors() throws -> [String: String] {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        let contents = try String(
            contentsOf: url.appendingPathComponent("packages/kodera-rs/vectors/proximity-beacon-v2.txt"),
            encoding: .utf8
        )
        var pairs: [String: String] = [:]
        for line in contents.split(separator: "\n") where !line.hasPrefix("#") {
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            XCTAssertEqual(parts.count, 2)
            pairs[parts[0]] = parts[1]
        }
        return pairs
    }

    func testIndependentRustVectorsAndEveryWireBitRefuseWithoutConsumingReplaySlot() throws {
        let values = try sharedVectors()
        let orgId = try XCTUnwrap(values["organisation"])
        let discoveryKey = try decodeHex(try XCTUnwrap(values["public_fixture_discovery_key"]))
        let deviceSeed = try decodeHex(try XCTUnwrap(values["public_fixture_device_seed"]))
        let unixSeconds = try XCTUnwrap(UInt64(try XCTUnwrap(values["unix_seconds"])))

        var sender = try ProximityBeaconV2Sender(
            organisationId: orgId,
            discoveryKey: discoveryKey,
            deviceSeed: deviceSeed
        )
        XCTAssertTrue(String(reflecting: sender).contains("[redacted]"))

        let first = try sender.emit(atUnixSeconds: unixSeconds)
        XCTAssertEqual(first.bytes, try decodeHex(try XCTUnwrap(values["sequence_zero"])))
        XCTAssertEqual(
            try sender.emit(atUnixSeconds: unixSeconds).bytes,
            try decodeHex(try XCTUnwrap(values["sequence_one"]))
        )
        XCTAssertEqual(
            try sender.emit(atUnixSeconds: (unixSeconds / 300 + 1) * 300).bytes,
            try decodeHex(try XCTUnwrap(values["next_window"]))
        )

        for byteIndex in 0..<ProximityBeaconV2.wireByteCount {
            for bit in 0..<8 {
                var mutated = Array(first.bytes)
                mutated[byteIndex] ^= (1 << bit)
                var receiver = try ProximityBeaconV2Receiver(
                    organisationId: orgId,
                    discoveryKey: discoveryKey,
                    capacity: 1
                )
                let expected: ProximityBeaconV2Error
                if byteIndex < 3 {
                    expected = .invalidInput
                } else if byteIndex < 7 {
                    expected = .epochMismatch
                } else {
                    expected = .authenticationFailed
                }
                XCTAssertThrowsError(
                    try receiver.accept(bytes: Data(mutated), nowUnixSeconds: unixSeconds)
                ) { error in
                    XCTAssertEqual(error as? ProximityBeaconV2Error, expected)
                }
                // Refusal did not burn replay capacity for the authentic frame
                _ = try receiver.accept(bytes: first.bytes, nowUnixSeconds: unixSeconds)
                XCTAssertThrowsError(
                    try receiver.accept(bytes: first.bytes, nowUnixSeconds: unixSeconds)
                ) { error in
                    XCTAssertEqual(error as? ProximityBeaconV2Error, .replay)
                }
            }
        }
    }

    func testDutyCycleAndBatteryBudgetBoundsRefuseLowPowerAndBurstScans() throws {
        let budget = ProximityDutyCycleBudget.standard
        let lowBattery = try ProximityBatterySnapshot(levelPercent: 12, isCharging: false, isLowPowerModeEnabled: false)
        let lowPowerMode = try ProximityBatterySnapshot(levelPercent: 90, isCharging: false, isLowPowerModeEnabled: true)
        let chargingLow = try ProximityBatterySnapshot(levelPercent: 10, isCharging: true, isLowPowerModeEnabled: false)

        XCTAssertThrowsError(try budget.validateScanStart(battery: lowBattery, lastScanStartedAt: nil, nowUnixSeconds: 1_000)) {
            XCTAssertEqual($0 as? ProximityBeaconV2Error, .batteryBudgetExceeded)
        }
        XCTAssertThrowsError(try budget.validateScanStart(battery: lowPowerMode, lastScanStartedAt: nil, nowUnixSeconds: 1_000)) {
            XCTAssertEqual($0 as? ProximityBeaconV2Error, .batteryBudgetExceeded)
        }
        XCTAssertNoThrow(try budget.validateScanStart(battery: chargingLow, lastScanStartedAt: nil, nowUnixSeconds: 1_000))

        // Cooldown: 10s scan + 50s cooldown => next scan requires t >= 1060
        XCTAssertThrowsError(try budget.validateScanStart(battery: .nominal, lastScanStartedAt: 1_000, nowUnixSeconds: 1_059)) {
            XCTAssertEqual($0 as? ProximityBeaconV2Error, .dutyCycleThrottled)
        }
        XCTAssertNoThrow(try budget.validateScanStart(battery: .nominal, lastScanStartedAt: 1_000, nowUnixSeconds: 1_060))

        XCTAssertThrowsError(try budget.validateBroadcast(battery: .nominal, emissionsInCurrentWindow: 6)) {
            XCTAssertEqual($0 as? ProximityBeaconV2Error, .dutyCycleThrottled)
        }
        XCTAssertNoThrow(try budget.validateBroadcast(battery: .nominal, emissionsInCurrentWindow: 5))
    }
}

import Foundation
import XCTest
@testable import KoderaDomain
#if canImport(CryptoKit)
import CryptoKit
#endif

final class ProximityFrameTests: XCTestCase {
    private let wireHex = "4b4501019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a03010bc380206ce2809961627269de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005"
    private func bytes(_ hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
        })
    }
    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// `kodera-rs` reads the same file: the bounds and the future-skew rule agree line for line.
    func testBoundsAndFutureRuleMatchTheSharedRustRules() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        let text = try String(contentsOf: url.appendingPathComponent("packages/kodera-rs/vectors/emergency-v1-rules.txt"), encoding: .utf8)
        var bounds: [String: Int] = [:], rules: [String: UInt64] = [:], cases = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) where !line.isEmpty && !line.hasPrefix("#") {
            let fields = line.split(separator: " ").map(String.init)
            switch (fields.first, fields.count) {
            case ("bound", 3): bounds[fields[1]] = try XCTUnwrap(Int(fields[2]), String(line))
            case ("rule", 3): rules[fields[1]] = try XCTUnwrap(UInt64(fields[2]), String(line))
            case ("case", 6):
                XCTAssertEqual(fields[1], "max_future_skew_ms", String(line))
                let now = try XCTUnwrap(UInt64(fields[3])), frame = try XCTUnwrap(UInt64(fields[4]))
                XCTAssertTrue(["accept", "refuse"].contains(fields[5]), String(line))
                XCTAssertEqual(ProximityBounds.isTooFarAhead(frameTimestampMilliseconds: frame, nowMilliseconds: now),
                               fields[5] == "refuse", fields[2])
                cases += 1
            default: XCTFail("unknown line in the shared rules: \(line)")
            }
        }
        XCTAssertEqual(bounds, ["queue_capacity": ProximityBounds.queueCapacity,
                                "roster_members": ProximityBounds.rosterMembers,
                                "replay_entries": ProximityBounds.replayEntries])
        XCTAssertEqual(rules, ["max_future_skew_ms": ProximityBounds.maxFutureSkewMilliseconds])
        XCTAssertGreaterThan(cases, 0)
        XCTAssertNoThrow(try ProximityReplayGuard(capacity: ProximityBounds.replayEntries))
        XCTAssertThrowsError(try ProximityReplayGuard(capacity: ProximityBounds.replayEntries + 1))
        XCTAssertFalse(ProximityBounds.isTooFarAhead(frameTimestampMilliseconds: .max, nowMilliseconds: .max))
    }
    func testCanonicalMultibyteFrameAndUUIDMatchSharedCore() throws {
        let frame = try ProximityFrame.decode(bytes(wireHex))
        XCTAssertEqual(frame.encode().count, 129)
        XCTAssertEqual(hex(frame.encode()), wireHex)
        XCTAssertEqual(frame.text.utf8.count, 11)
        XCTAssertEqual(frame.text, "\u{00c0} l\u{2019}abri")
        XCTAssertEqual(frame.status, .safe)
        XCTAssertEqual(frame.ttlHops, 3)
        XCTAssertEqual(frame.messageID.timestampMilliseconds, 1_762_520_100_000)
        XCTAssertEqual(try ProximityMessageID(timestampMilliseconds: 1_762_520_100_000,
            randomness: Data(repeating: 3, count: 10)), frame.messageID)
        XCTAssertEqual(frame.decrementHop()?.ttlHops, 2)
        XCTAssertEqual(frame.decrementHop()?.decrementHop()?.ttlHops, 1)
        XCTAssertNil(frame.decrementHop()?.decrementHop()?.decrementHop())
        XCTAssertEqual(frame.signingTranscript, frame.decrementHop()?.signingTranscript)
    }

    func testCanonicalBeaconAndRotationBoundaries() throws {
        let salt = Data(repeating: 0x42, count: 32)
        XCTAssertEqual(hex(try ProximityBeacon.compute(salt: salt, unixSeconds: 1_762_520_100)), "1be3967637ebb0ea")
        XCTAssertEqual(try ProximityBeacon.compute(salt: salt, unixSeconds: 1_762_520_100),
                       try ProximityBeacon.compute(salt: salt, unixSeconds: 1_762_520_399))
        XCTAssertNotEqual(try ProximityBeacon.compute(salt: salt, unixSeconds: 1_762_520_100),
                          try ProximityBeacon.compute(salt: salt, unixSeconds: 1_762_520_400))
        XCTAssertThrowsError(try ProximityBeacon.compute(salt: Data(), unixSeconds: 0))
        XCTAssertEqual(hex(ProximitySHA256.digest(Data("abc".utf8))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(hex(ProximitySHA256.hmac(key: Data(repeating: 0x0b, count: 20), data: Data("Hi There".utf8))),
                       "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
    }

    func testMalformedFramesAreRejectedBeforeAdmission() throws {
        let wire = bytes(wireHex)
        for index in [0, 2, 9, 11, 51, 52, 53] {
            var bad = wire
            switch index {
            case 9: bad[index] = 0x60
            case 11: bad[index] = 0xc0
            case 51: bad[index] = 0
            case 52: bad[index] = 4
            default: bad[index] ^= 0xff
            }
            XCTAssertThrowsError(try ProximityFrame.decode(bad), "mutation offset \(index)")
        }
        for count in 0..<118 { XCTAssertThrowsError(try ProximityFrame.decode(wire.prefix(count))) }
        XCTAssertThrowsError(try ProximityFrame.decode(wire + Data([0])))
        var ttl = wire; ttl[51] = 7
        XCTAssertThrowsError(try ProximityFrame.decode(ttl))
        var utf8 = wire; utf8[54] = 0xff
        XCTAssertThrowsError(try ProximityFrame.decode(utf8))
        XCTAssertThrowsError(try ProximityMessageID(timestampMilliseconds: UInt64.max, randomness: Data(repeating: 0, count: 10)))
        var guardState = try ProximityReplayGuard(capacity: 2)
        let first = try ProximityFrame.decode(wire).messageID
        XCTAssertTrue(guardState.acceptOnce(first)); XCTAssertFalse(guardState.acceptOnce(first))
        for timestamp in [1_762_520_100_001, 1_762_520_100_002] as [UInt64] {
            XCTAssertTrue(guardState.acceptOnce(try ProximityMessageID(timestampMilliseconds: timestamp, randomness: Data(repeating: 0, count: 10))))
        }
        XCTAssertEqual(guardState.count, 2)
        guardState.clear(); XCTAssertEqual(guardState.count, 0)
        XCTAssertThrowsError(try ProximityReplayGuard(capacity: 0))
        XCTAssertThrowsError(try ProximityReplayGuard(capacity: 4097))
    }

    func testCanonicalSignatureAndEverySignedFieldRefuseTampering() throws {
        let frame = try ProximityFrame.decode(bytes(wireHex))
        XCTAssertThrowsError(try frame.verified(allowedRoster: [])) { XCTAssertEqual($0 as? ProximityError, .unauthorizedSender) }
        #if canImport(CryptoKit)
        XCTAssertNoThrow(try frame.verified(allowedRoster: [frame.senderPublicKey]))
        XCTAssertNoThrow(try frame.decrementHop()!.verified(allowedRoster: [frame.senderPublicKey]))
        for index in [3, 19, 52, 54, 128] {
            var bad = frame.encode(); bad[index] ^= index == 52 ? 1 : 0x01
            let changed = try ProximityFrame.decode(bad)
            XCTAssertThrowsError(try changed.verified(allowedRoster: [frame.senderPublicKey, changed.senderPublicKey]))
        }
        let privateKey = Curve25519.Signing.PrivateKey()
        let signer = try Ed25519ProximitySigner(rawPrivateKey: privateKey.rawRepresentation)
        let maximum = String(repeating: "x", count: 138)
        let signed = try ProximityFrame.signed(messageID: frame.messageID, ttlHops: 6, status: .needAssistance,
                                               text: maximum, signer: signer)
        XCTAssertEqual(signed.encode().count, 256)
        XCTAssertNoThrow(try signed.verified(allowedRoster: [signer.publicKey]))
        XCTAssertThrowsError(try ProximityFrame.signed(messageID: frame.messageID, ttlHops: 6, status: .safe,
                                                      text: maximum + "x", signer: signer))
        XCTAssertEqual(String(reflecting: signer), "Ed25519ProximitySigner(<redacted>)")
        #else
        XCTAssertThrowsError(try frame.verified(allowedRoster: [frame.senderPublicKey])) {
            XCTAssertEqual($0 as? ProximityError, .cryptoUnavailable)
        }
        #endif
    }
}

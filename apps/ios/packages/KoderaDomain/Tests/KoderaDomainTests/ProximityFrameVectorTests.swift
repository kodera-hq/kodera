import Foundation
import XCTest
@testable import KoderaDomain

/// Holds this codec to `packages/kodera-rs/vectors/proximity-frame-v1.txt`, the file `kodera-rs`
/// and the Android client read too. The v1 wire format is frozen: these tests fail when a byte moves.
final class ProximityFrameVectorTests: XCTestCase {
    private struct FrameVector {
        let name: String, ttlHops: UInt8, status: UInt8, timestampMilliseconds: UInt64
        let text: Data, wire: Data, transcript: Data
    }
    private struct Vectors {
        var constants: [String: String] = [:], frames: [FrameVector] = [], refused: [(name: String, wire: Data)] = []
    }

    private func bytes(_ hex: String) throws -> Data {
        XCTAssertEqual(hex.count % 2, 0, hex)
        return Data(try stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            return try XCTUnwrap(UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16), hex)
        })
    }

    /// Strict: a line outside the grammar fails the test rather than being skipped.
    private func vectors() throws -> Vectors {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        let text = try String(contentsOf: url.appendingPathComponent("packages/kodera-rs/vectors/proximity-frame-v1.txt"), encoding: .utf8)
        var parsed = Vectors()
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) where !line.isEmpty && !line.hasPrefix("#") {
            let fields = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
            switch (fields.first, fields.count) {
            case ("const", 3):
                XCTAssertNil(parsed.constants[fields[1]], String(line)); parsed.constants[fields[1]] = fields[2]
            case ("frame", 8):
                parsed.frames.append(FrameVector(
                    name: fields[1], ttlHops: try XCTUnwrap(UInt8(fields[2])), status: try XCTUnwrap(UInt8(fields[3])),
                    timestampMilliseconds: try XCTUnwrap(UInt64(fields[4])),
                    text: fields[5] == "-" ? Data() : try bytes(fields[5]),
                    wire: try bytes(fields[6]), transcript: try bytes(fields[7])))
            case ("refuse", 3): parsed.refused.append((fields[1], try bytes(fields[2])))
            default: XCTFail("unknown line in the shared frame vectors: \(line)")
            }
        }
        return parsed
    }

    /// True when `wire` is, for this codec, exactly the frame the vector states: it decodes to the
    /// stated fields, encodes back to the vector's own bytes and signs the vector's own transcript.
    private func conforms(_ vector: FrameVector, _ wire: Data) -> Bool {
        guard let frame = try? ProximityFrame.decode(wire) else { return false }
        return frame.ttlHops == vector.ttlHops
            && frame.status.rawValue == vector.status
            && frame.messageID.timestampMilliseconds == vector.timestampMilliseconds
            && Data(frame.text.utf8) == vector.text
            && frame.encode() == vector.wire
            && frame.signingTranscript == vector.transcript
    }

    func testSharedVectorsStateTheFrozenConstantsThisCodecEncodes() throws {
        let shared = try vectors()
        XCTAssertEqual(shared.constants.count, 7)
        XCTAssertEqual(shared.constants["magic_hex"], "4b45")
        XCTAssertEqual(shared.constants["version"], "1")
        XCTAssertEqual(shared.constants["fixed_overhead_bytes"], String(ProximityFrame.fixedOverhead))
        XCTAssertEqual(shared.constants["max_frame_bytes"], "256")
        XCTAssertEqual(shared.constants["max_text_bytes"], String(ProximityFrame.maximumTextBytes))
        XCTAssertEqual(shared.constants["max_ttl_hops"], "6")
        // The signed label keeps the channel's first name: it is wire, not vocabulary.
        let label = try bytes(try XCTUnwrap(shared.constants["signing_label_hex"]))
        XCTAssertEqual(label, Data("kodera-emergency-v1:".utf8))
        let canonical = try ProximityFrame.decode(try XCTUnwrap(shared.frames.first).wire)
        XCTAssertEqual(canonical.encode().prefix(3), try bytes("4b4501"))
        XCTAssertEqual(canonical.signingTranscript.prefix(label.count), label)
    }

    func testEverySharedFrameDecodesEncodesAndSignsByteForByte() throws {
        let shared = try vectors()
        XCTAssertGreaterThanOrEqual(shared.frames.count, 5)
        XCTAssertEqual(shared.frames.first?.name, "canonical")
        XCTAssertEqual(shared.frames.first?.wire.count, 129)
        var statuses = Set<UInt8>(), sizes = Set<Int>()
        for vector in shared.frames {
            XCTAssertTrue(conforms(vector, vector.wire), vector.name)
            let frame = try ProximityFrame.decode(vector.wire)
            XCTAssertEqual(frame.signature, vector.wire.suffix(64), vector.name)
            XCTAssertEqual(frame.senderPublicKey, Data(Array(vector.wire)[19..<51]), vector.name)
            #if canImport(CryptoKit)
            // Every shared frame carries a genuine Ed25519 signature; the platform verifier accepts it.
            XCTAssertNoThrow(try frame.verified(allowedRoster: [frame.senderPublicKey]), vector.name)
            #endif
            statuses.insert(vector.status); sizes.insert(vector.wire.count)
        }
        XCTAssertEqual(statuses, [0, 1, 2, 3])
        XCTAssertTrue(sizes.contains(118) && sizes.contains(256))
    }

    func testEverySharedRefusedFrameFailsToDecode() throws {
        let shared = try vectors()
        XCTAssertGreaterThanOrEqual(shared.refused.count, 15)
        for (name, wire) in shared.refused { XCTAssertThrowsError(try ProximityFrame.decode(wire), name) }
    }

    /// Refusal mutation: flip one bit of a shared frame at every offset. The vector check must fail
    /// each time, so no byte of the frozen layout is outside what the vectors pin.
    func testFlippingAnySingleByteOfASharedFrameBreaksConformance() throws {
        for vector in try vectors().frames {
            for offset in 0..<vector.wire.count {
                var mutated = vector.wire
                mutated[offset] ^= 0x01
                XCTAssertFalse(conforms(vector, mutated), "\(vector.name): byte \(offset) is not pinned")
            }
            XCTAssertFalse(conforms(vector, vector.wire.dropFirst()))
            XCTAssertFalse(conforms(vector, vector.wire.dropLast()))
            XCTAssertFalse(conforms(vector, vector.wire + Data([0])))
        }
    }
}

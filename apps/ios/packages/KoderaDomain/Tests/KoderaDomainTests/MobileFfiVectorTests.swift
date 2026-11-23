import Foundation
import XCTest
@testable import KoderaDomain

/// Verifies byte-level parity between `KoderaDomain` mobile FFI models/codecs and `packages/kodera-rs/vectors/mobile-ffi-v1.txt`.
final class MobileFfiVectorTests: XCTestCase {
    private func sharedVectors() throws -> [String: String] {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        let contents = try String(
            contentsOf: url.appendingPathComponent("packages/kodera-rs/vectors/mobile-ffi-v1.txt"),
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

    func testUuidV7MatchesRustGoldenVectorAndRejectsInvalidForms() throws {
        let values = try sharedVectors()
        let unixTsMs = try XCTUnwrap(UInt64(try XCTUnwrap(values["unix_ts_ms"])))
        let randBytes = Array(try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["uuid_rand_hex"])))
        let expected = try XCTUnwrap(values["expected_uuid_v7"])

        let deterministic = try UuidV7Identifier(unixTimestampMs: unixTsMs, randomBytes: randBytes)
        XCTAssertEqual(deterministic.description, expected)
        XCTAssertEqual(deterministic.timestampMs, unixTsMs)
        XCTAssertEqual(try UuidV7Identifier(parsing: expected), deterministic)

        let minted = try UuidV7Identifier.mint(nowMs: unixTsMs)
        XCTAssertEqual(minted.timestampMs, unixTsMs)

        // Reject UUIDv4 (version nibble 4 instead of 7) and uppercase hex.
        XCTAssertThrowsError(try UuidV7Identifier(parsing: "00000000-0000-4000-8000-000000000001")) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .invalidInput)
        }
        XCTAssertThrowsError(try UuidV7Identifier(parsing: expected.uppercased())) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .invalidInput)
        }
    }

    func testKdv1SessionVaultMatchesRustGoldenVectorAndRefusesTamperingOrCrossOrg() throws {
        let values = try sharedVectors()
        let orgId = try XCTUnwrap(values["organisation"])
        let deviceId = try XCTUnwrap(values["device_id"])
        let keyData = try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["public_fixture_vault_material"]))
        let nonceData = try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["public_fixture_vault_nonce"]))
        let plaintext = try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["vault_plaintext_hex"]))
        let expectedAad = try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["vault_aad_hex"]))
        let expectedSealed = try KoderaMobileFfiBridge.decodeHex(try XCTUnwrap(values["vault_sealed_kdv1_hex"]))

        let aad = try Kdv1SessionVaultCodec.aad(organisationId: orgId, deviceId: deviceId)
        XCTAssertEqual(aad, expectedAad)

        let sealed = try Kdv1SessionVaultCodec.seal(
            organisationId: orgId,
            deviceId: deviceId,
            keyData: keyData,
            nonceData: nonceData,
            plaintext: plaintext
        )
        XCTAssertEqual(sealed, expectedSealed)

        let opened = try Kdv1SessionVaultCodec.open(
            organisationId: orgId,
            deviceId: deviceId,
            keyData: keyData,
            sealed: sealed
        )
        XCTAssertEqual(opened, plaintext)

        // Cross-organisation and cross-device AAD binding must fail closed.
        XCTAssertThrowsError(
            try Kdv1SessionVaultCodec.open(
                organisationId: "00000000-0000-4000-8000-000000000002",
                deviceId: deviceId,
                keyData: keyData,
                sealed: sealed
            )
        ) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .authenticationFailed)
        }
        XCTAssertThrowsError(
            try Kdv1SessionVaultCodec.open(
                organisationId: orgId,
                deviceId: "01935800-0000-7000-8000-000000000099",
                keyData: keyData,
                sealed: sealed
            )
        ) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .authenticationFailed)
        }

        // Flipping every byte of the KDV1 wire frame must refuse.
        for byteIndex in 0..<sealed.count {
            var mutated = Array(sealed)
            mutated[byteIndex] ^= 0x01
            let expectedError: KoderaMobileFfiError = byteIndex < 4 ? .invalidInput : .authenticationFailed
            XCTAssertThrowsError(
                try Kdv1SessionVaultCodec.open(
                    organisationId: orgId,
                    deviceId: deviceId,
                    keyData: keyData,
                    sealed: Data(mutated)
                )
            ) {
                XCTAssertEqual($0 as? KoderaMobileFfiError, expectedError)
            }
        }
    }

    func testSessionEnvelopeTrackerReactionValidationAndFfiBridgePacketRoundTrips() throws {
        let values = try sharedVectors()
        let orgId = try XCTUnwrap(values["organisation"])
        let roomId = try UuidV7Identifier(parsing: try XCTUnwrap(values["envelope_room_id"]))
        let msg1 = try UuidV7Identifier(parsing: try XCTUnwrap(values["envelope_msg_1"]))
        let msg2 = try UuidV7Identifier(parsing: try XCTUnwrap(values["envelope_msg_2"]))

        var tracker = try SessionEnvelopeTrackerModel(organisationId: orgId, roomCapacity: 4, replayCapacity: 8)
        let header1 = try SessionEnvelopeHeaderModel(
            organisationId: orgId,
            roomId: roomId,
            messageId: msg1,
            epoch: 2,
            algorithm: .openMlsDraft
        )
        try tracker.verifyAndObserve(header1)

        // Replay of msg1 is refused.
        XCTAssertThrowsError(try tracker.verifyAndObserve(header1)) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .replayDetected)
        }

        // Stale epoch rollback is refused.
        let rollback = try SessionEnvelopeHeaderModel(
            organisationId: orgId,
            roomId: roomId,
            messageId: msg2,
            epoch: 1,
            algorithm: .openMlsDraft
        )
        XCTAssertThrowsError(try tracker.verifyAndObserve(rollback)) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .staleEpoch)
        }

        // Algorithm downgrade is refused.
        let downgrade = try SessionEnvelopeHeaderModel(
            organisationId: orgId,
            roomId: roomId,
            messageId: msg2,
            epoch: 3,
            algorithm: .matrixOlmV1
        )
        XCTAssertThrowsError(try tracker.verifyAndObserve(downgrade)) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .algorithmMismatch)
        }

        // Monotonic forward epoch succeeds.
        let forward = try SessionEnvelopeHeaderModel(
            organisationId: orgId,
            roomId: roomId,
            messageId: msg2,
            epoch: 3,
            algorithm: .openMlsDraft
        )
        try tracker.verifyAndObserve(forward)
        XCTAssertEqual(tracker.roomCount, 1)
        XCTAssertEqual(tracker.replayCount, 2)

        // Reaction key parity with Rust golden vectors.
        for validEmoji in try XCTUnwrap(values["valid_reactions"]).split(separator: ",").map(String.init) {
            XCTAssertTrue(ReactionKeyValidator.isValid(validEmoji), "expected valid reaction: \(validEmoji)")
        }
        for invalid in ["", "hello", "👍👎", " 👍", "👍\u{200D}", "123"] {
            XCTAssertFalse(ReactionKeyValidator.isValid(invalid), "expected invalid reaction: \(invalid)")
        }

        // Unified JSON wire schema golden vectors (identical across Rust, Swift, and Kotlin).
        let bridge = KoderaMobileFfiBridge()
        for (reqKey, respKey) in [
            ("req_uuid_v7_mint_json", "resp_uuid_v7_mint_json"),
            ("req_session_vault_seal_json", "resp_session_vault_seal_json"),
            ("req_session_vault_open_json", "resp_session_vault_open_json"),
            ("req_session_envelope_observe_json", "resp_session_envelope_observe_json"),
            ("req_reaction_validate_json", "resp_reaction_validate_json"),
            ("req_wakeup_admit_json", "resp_wakeup_admit_json"),
        ] {
            let reqData = Data(try XCTUnwrap(values[reqKey]).utf8)
            let expectedResp = try XCTUnwrap(values[respKey])
            let resp = try bridge.invoke(KoderaFfiPacket(payload: reqData))
            XCTAssertEqual(resp.status, 0, reqKey)
            XCTAssertEqual(String(decoding: resp.payload, as: UTF8.self), expectedResp, reqKey)
        }

        // Replay vector via unified session_envelope_verify_and_observe wire schema.
        let replayReqData = Data(try XCTUnwrap(values["req_session_envelope_replay_json"]).utf8)
        XCTAssertThrowsError(try bridge.invoke(KoderaFfiPacket(payload: replayReqData))) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .replayDetected)
        }

        // Wakeup transport + epoch_ms + nested cleartext & type/range refusals.
        let admittedTransportEpoch = try ZeroPayloadWakeupEnvelope.admit(
            jsonData: Data(try XCTUnwrap(values["valid_wakeup_transport_epoch_json"]).utf8)
        )
        XCTAssertEqual(admittedTransportEpoch.transport, "unifiedpush")
        XCTAssertEqual(admittedTransportEpoch.epochMs, 1_732_320_000_123)

        let nestedLeakHex = KoderaMobileFfiBridge.encodeHex(
            Data(try XCTUnwrap(values["invalid_wakeup_nested_transport_json"]).utf8)
        )
        let nestedLeakReq = Data("{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"\(nestedLeakHex)\"}".utf8)
        XCTAssertThrowsError(try bridge.invoke(KoderaFfiPacket(payload: nestedLeakReq))) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .cleartextForbidden(field: "transport.body"))
        }

        for dupJson in [
            try XCTUnwrap(values["invalid_wakeup_duplicate_key_json"]),
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"transport\":\"apns\",\"trans\\u0070ort\":{\"body\":\"secret\"}}",
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"aps\":{\"content-available\":1,\"content-available\":1}}",
        ] {
            XCTAssertThrowsError(try ZeroPayloadWakeupEnvelope.admit(jsonData: Data(dupJson.utf8))) {
                XCTAssertEqual($0 as? KoderaMobileFfiError, .invalidJSON)
            }
            let dupHex = KoderaMobileFfiBridge.encodeHex(Data(dupJson.utf8))
            let dupReq = Data("{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"\(dupHex)\"}".utf8)
            XCTAssertThrowsError(try bridge.invoke(KoderaFfiPacket(payload: dupReq))) {
                XCTAssertEqual($0 as? KoderaMobileFfiError, .invalidJSON)
            }
        }

        for invalidWakeupKey in [
            "invalid_wakeup_nonstring_transport_json",
            "invalid_wakeup_unknown_transport_json",
            "invalid_wakeup_bad_epoch_json",
        ] {
            let badHex = KoderaMobileFfiBridge.encodeHex(
                Data(try XCTUnwrap(values[invalidWakeupKey]).utf8)
            )
            let badReq = Data("{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"\(badHex)\"}".utf8)
            XCTAssertThrowsError(try bridge.invoke(KoderaFfiPacket(payload: badReq)), invalidWakeupKey) {
                XCTAssertEqual($0 as? KoderaMobileFfiError, .invalidInput)
            }
        }

        // Exercise injectable PacketDispatcher seam + error forwarding.
        struct StubPacketDispatcher: PacketDispatcher {
            func dispatch(_ request: KoderaFfiPacket) throws -> KoderaFfiPacket {
                let inputStr = String(decoding: request.payload, as: UTF8.self)
                if inputStr.contains("replay") {
                    throw KoderaMobileFfiError.replayDetected
                }
                return try KoderaFfiPacket(payload: Data("{\"ok\":true,\"valid\":true}".utf8), status: 0)
            }
        }
        let customBridge = KoderaMobileFfiBridge(dispatcher: StubPacketDispatcher())
        let cOk = try customBridge.invoke(KoderaFfiPacket(payload: Data("{\"op\":\"reaction_validate\",\"key\":\"👍\"}".utf8)))
        XCTAssertEqual(String(decoding: cOk.payload, as: UTF8.self), "{\"ok\":true,\"valid\":true}")
        XCTAssertThrowsError(try customBridge.invoke(KoderaFfiPacket(payload: Data("{\"op\":\"replay\"}".utf8)))) {
            XCTAssertEqual($0 as? KoderaMobileFfiError, .replayDetected)
        }
    }
}

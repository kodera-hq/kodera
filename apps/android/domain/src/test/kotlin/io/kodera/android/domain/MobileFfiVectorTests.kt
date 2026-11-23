package io.kodera.android.domain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Holds Android `:domain` mobile FFI models and `KDV1` AES-256-GCM vault codecs byte-for-byte
 * to `packages/kodera-rs/vectors/mobile-ffi-v1.txt` and iOS `KoderaDomainTests`.
 */
class MobileFfiVectorTests {
    private fun loadSharedVectors(): Map<String, String> {
        val relativePath = "packages/kodera-rs/vectors/mobile-ffi-v1.txt"
        val repoRoot = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, relativePath).isFile }
        val entries = LinkedHashMap<String, String>()
        File(repoRoot, relativePath).readLines(Charsets.UTF_8)
            .filter { it.isNotBlank() && !it.startsWith("#") }
            .forEach { line ->
                val idx = line.indexOf('=')
                assertTrue("Invalid vector line: $line", idx > 0)
                val key = line.substring(0, idx)
                val value = line.substring(idx + 1)
                entries[key] = value
            }
        return entries
    }

    @Test
    fun uuidV7MatchesRustGoldenVectorAndRejectsInvalidForms() {
        val vectors = loadSharedVectors()
        val unixTsMs = vectors.getValue("unix_ts_ms").toLong()
        val randBytes = KoderaMobileFfiBridge.decodeHex(vectors.getValue("uuid_rand_hex"))
        val expected = vectors.getValue("expected_uuid_v7")

        val deterministic = UuidV7Identifier.fromParts(unixTsMs, randBytes)
        assertEquals(expected, deterministic.toString())
        assertEquals(unixTsMs, deterministic.timestampMs)
        assertEquals(deterministic, UuidV7Identifier.parse(expected))

        val minted = UuidV7Identifier.mint(unixTsMs)
        assertEquals(unixTsMs, minted.timestampMs)

        val v4Failure = assertThrows(KoderaMobileFfiFailure::class.java) {
            UuidV7Identifier.parse("00000000-0000-4000-8000-000000000001")
        }
        assertEquals(KoderaMobileFfiError.INVALID_INPUT, v4Failure.reason)
    }

    @Test
    fun kdv1SessionVaultMatchesRustGoldenVectorAndRefusesTamperingAndCrossOrg() {
        val vectors = loadSharedVectors()
        val orgId = vectors.getValue("organisation")
        val deviceId = vectors.getValue("device_id")
        val keyBytes = KoderaMobileFfiBridge.decodeHex(vectors.getValue("public_fixture_vault_material"))
        val nonceBytes = KoderaMobileFfiBridge.decodeHex(vectors.getValue("public_fixture_vault_nonce"))
        val plaintext = KoderaMobileFfiBridge.decodeHex(vectors.getValue("vault_plaintext_hex"))
        val expectedAad = KoderaMobileFfiBridge.decodeHex(vectors.getValue("vault_aad_hex"))
        val expectedSealed = KoderaMobileFfiBridge.decodeHex(vectors.getValue("vault_sealed_kdv1_hex"))

        assertArrayEquals(expectedAad, Kdv1SessionVaultCodec.aad(orgId, deviceId))

        val sealed = Kdv1SessionVaultCodec.seal(
            organisationId = orgId,
            deviceId = deviceId,
            keyBytes = keyBytes,
            nonceBytes = nonceBytes,
            plaintext = plaintext,
        )
        assertArrayEquals(expectedSealed, sealed)
        assertArrayEquals(plaintext, Kdv1SessionVaultCodec.open(orgId, deviceId, keyBytes, sealed))

        // Cross-org and cross-device AAD mismatches fail closed.
        val crossOrg = assertThrows(KoderaMobileFfiFailure::class.java) {
            Kdv1SessionVaultCodec.open("00000000-0000-4000-8000-000000000002", deviceId, keyBytes, sealed)
        }
        assertEquals(KoderaMobileFfiError.AUTHENTICATION_FAILED, crossOrg.reason)

        val crossDevice = assertThrows(KoderaMobileFfiFailure::class.java) {
            Kdv1SessionVaultCodec.open(orgId, "01935800-0000-7000-8000-000000000099", keyBytes, sealed)
        }
        assertEquals(KoderaMobileFfiError.AUTHENTICATION_FAILED, crossDevice.reason)

        // Flip every byte across the entire KDV1 frame.
        for (byteIndex in sealed.indices) {
            val mutated = sealed.copyOf()
            mutated[byteIndex] = (mutated[byteIndex].toInt() xor 0x01).toByte()
            val expectedError = if (byteIndex < 4) {
                KoderaMobileFfiError.INVALID_INPUT
            } else {
                KoderaMobileFfiError.AUTHENTICATION_FAILED
            }
            val failure = assertThrows(KoderaMobileFfiFailure::class.java) {
                Kdv1SessionVaultCodec.open(orgId, deviceId, keyBytes, mutated)
            }
            assertEquals("byteIndex=$byteIndex", expectedError, failure.reason)
        }
    }

    @Test
    fun sessionEnvelopeTrackerReactionValidationAndFfiBridgePacketRoundTrips() {
        val vectors = loadSharedVectors()
        val orgId = vectors.getValue("organisation")
        val roomId = UuidV7Identifier.parse(vectors.getValue("envelope_room_id"))
        val msg1 = UuidV7Identifier.parse(vectors.getValue("envelope_msg_1"))
        val msg2 = UuidV7Identifier.parse(vectors.getValue("envelope_msg_2"))

        val tracker = SessionEnvelopeTrackerModel(orgId, roomCapacity = 4, replayCapacity = 8)
        val header1 = SessionEnvelopeHeaderModel(orgId, roomId, msg1, epoch = 2L, SessionEnvelopeCryptoAlgorithm.OPENMLS_DRAFT)
        tracker.verifyAndObserve(header1)

        val replay = assertThrows(KoderaMobileFfiFailure::class.java) { tracker.verifyAndObserve(header1) }
        assertEquals(KoderaMobileFfiError.REPLAY_DETECTED, replay.reason)

        val rollback = assertThrows(KoderaMobileFfiFailure::class.java) {
            tracker.verifyAndObserve(
                SessionEnvelopeHeaderModel(orgId, roomId, msg2, epoch = 1L, SessionEnvelopeCryptoAlgorithm.OPENMLS_DRAFT)
            )
        }
        assertEquals(KoderaMobileFfiError.STALE_EPOCH, rollback.reason)

        val downgrade = assertThrows(KoderaMobileFfiFailure::class.java) {
            tracker.verifyAndObserve(
                SessionEnvelopeHeaderModel(orgId, roomId, msg2, epoch = 3L, SessionEnvelopeCryptoAlgorithm.MATRIX_OLM_V1)
            )
        }
        assertEquals(KoderaMobileFfiError.ALGORITHM_MISMATCH, downgrade.reason)

        tracker.verifyAndObserve(
            SessionEnvelopeHeaderModel(orgId, roomId, msg2, epoch = 3L, SessionEnvelopeCryptoAlgorithm.OPENMLS_DRAFT)
        )
        assertEquals(1, tracker.roomCount)
        assertEquals(2, tracker.replayCount)

        for (emoji in vectors.getValue("valid_reactions").split(',')) {
            assertTrue("Expected valid emoji: $emoji", ReactionKeyValidator.isValid(emoji))
        }
        for (invalid in listOf("", "hello", "👍👎", " 👍", "👍\u200D", "123")) {
            assertFalse("Expected invalid emoji: $invalid", ReactionKeyValidator.isValid(invalid))
        }

        val bridge = KoderaMobileFfiBridge()
        val unifiedPairs = listOf(
            "req_uuid_v7_mint_json" to "resp_uuid_v7_mint_json",
            "req_session_vault_seal_json" to "resp_session_vault_seal_json",
            "req_session_vault_open_json" to "resp_session_vault_open_json",
            "req_session_envelope_observe_json" to "resp_session_envelope_observe_json",
            "req_reaction_validate_json" to "resp_reaction_validate_json",
            "req_wakeup_admit_json" to "resp_wakeup_admit_json",
        )
        for ((reqKey, respKey) in unifiedPairs) {
            val reqBytes = vectors.getValue(reqKey).toByteArray(Charsets.UTF_8)
            val resp = bridge.invoke(KoderaFfiPacket(reqBytes))
            assertEquals(reqKey, 0, resp.status)
            assertEquals(reqKey, vectors.getValue(respKey), String(resp.payloadBytes(), Charsets.UTF_8))
        }

        val replayPacketErr = assertThrows(KoderaMobileFfiFailure::class.java) {
            bridge.invoke(KoderaFfiPacket(vectors.getValue("req_session_envelope_replay_json").toByteArray(Charsets.UTF_8)))
        }
        assertEquals(KoderaMobileFfiError.REPLAY_DETECTED, replayPacketErr.reason)

        val admittedWithTransport = ZeroPayloadWakeupEnvelope.admit(
            vectors.getValue("valid_wakeup_transport_epoch_json").toByteArray(Charsets.UTF_8)
        )
        assertEquals("unifiedpush", admittedWithTransport.transport)
        assertEquals(1_732_320_000_123L, admittedWithTransport.epochMs)

        val nestedLeakHex = KoderaMobileFfiBridge.encodeHex(
            vectors.getValue("invalid_wakeup_nested_transport_json").toByteArray(Charsets.UTF_8)
        )
        val nestedLeakErr = assertThrows(KoderaMobileFfiFailure::class.java) {
            bridge.invoke(KoderaFfiPacket("""{"op":"wakeup_envelope_admit","payload_hex":"$nestedLeakHex"}""".toByteArray(Charsets.UTF_8)))
        }
        assertEquals(KoderaMobileFfiError.CLEARTEXT_FORBIDDEN, nestedLeakErr.reason)
        assertEquals("transport.body", nestedLeakErr.detail)

        for (dupJson in listOf(
            vectors.getValue("invalid_wakeup_duplicate_key_json"),
            """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"00000000-0000-4000-8000-000000000001","sync_hint":"sync_1","transport":"apns","trans\u0070ort":{"body":"secret"}}""",
            """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"00000000-0000-4000-8000-000000000001","sync_hint":"sync_1","aps":{"content-available":1,"content-available":1}}""",
        )) {
            val directErr = assertThrows(KoderaMobileFfiFailure::class.java) {
                ZeroPayloadWakeupEnvelope.admit(dupJson.toByteArray(Charsets.UTF_8))
            }
            assertEquals(KoderaMobileFfiError.INVALID_JSON, directErr.reason)
            val dupHex = KoderaMobileFfiBridge.encodeHex(dupJson.toByteArray(Charsets.UTF_8))
            val bridgeErr = assertThrows(KoderaMobileFfiFailure::class.java) {
                bridge.invoke(KoderaFfiPacket("""{"op":"wakeup_envelope_admit","payload_hex":"$dupHex"}""".toByteArray(Charsets.UTF_8)))
            }
            assertEquals(KoderaMobileFfiError.INVALID_JSON, bridgeErr.reason)
        }

        for (invalidKey in listOf(
            "invalid_wakeup_nonstring_transport_json",
            "invalid_wakeup_unknown_transport_json",
            "invalid_wakeup_bad_epoch_json",
        )) {
            val hex = KoderaMobileFfiBridge.encodeHex(vectors.getValue(invalidKey).toByteArray(Charsets.UTF_8))
            val err = assertThrows(invalidKey, KoderaMobileFfiFailure::class.java) {
                bridge.invoke(KoderaFfiPacket("""{"op":"wakeup_envelope_admit","payload_hex":"$hex"}""".toByteArray(Charsets.UTF_8)))
            }
            assertEquals(invalidKey, KoderaMobileFfiError.INVALID_INPUT, err.reason)
        }

        val customBridge = KoderaMobileFfiBridge(PacketDispatcher { req ->
            val text = String(req.payloadBytes(), Charsets.UTF_8)
            if (text.contains("replay")) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.REPLAY_DETECTED)
            }
            KoderaFfiPacket("""{"ok":true,"valid":true}""".toByteArray(Charsets.UTF_8), status = 0)
        })
        val okCustom = customBridge.invoke(KoderaFfiPacket("""{"op":"reaction_validate","key":"👍"}""".toByteArray(Charsets.UTF_8)))
        assertEquals("""{"ok":true,"valid":true}""", String(okCustom.payloadBytes(), Charsets.UTF_8))
        val errCustom = assertThrows(KoderaMobileFfiFailure::class.java) {
            customBridge.invoke(KoderaFfiPacket("""{"op":"replay"}""".toByteArray(Charsets.UTF_8)))
        }
        assertEquals(KoderaMobileFfiError.REPLAY_DETECTED, errCustom.reason)

        for (extraInvalid in listOf(
            """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"00000000-0000-4000-8000-000000000001","sync_hint":"sync_1","epoch_ms":-5}""",
            """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"00000000-0000-4000-8000-000000000001","sync_hint":"sync_1","epoch_ms":1.5}""",
            """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"00000000-0000-4000-8000-000000000001","sync_hint":"sync_1","transport":null}""",
        )) {
            val err = assertThrows(KoderaMobileFfiFailure::class.java) {
                ZeroPayloadWakeupEnvelope.admit(extraInvalid.toByteArray(Charsets.UTF_8))
            }
            assertEquals(KoderaMobileFfiError.INVALID_INPUT, err.reason)
        }
    }
}

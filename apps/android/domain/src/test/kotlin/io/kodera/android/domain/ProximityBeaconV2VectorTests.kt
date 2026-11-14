package io.kodera.android.domain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Holds `ProximityBeaconV2` byte-for-byte to `packages/kodera-rs/vectors/proximity-beacon-v2.txt`,
 * matching both `packages/kodera-rs` and iOS `ProximityBeaconV2`.
 */
class ProximityBeaconV2VectorTests {
    private fun loadSharedVectors(): Map<String, String> {
        val relativePath = "packages/kodera-rs/vectors/proximity-beacon-v2.txt"
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
                assertFalse("Duplicate vector key: $key", entries.containsKey(key))
                entries[key] = value
            }
        return entries
    }

    @Test
    fun sharedRustVectorsMatchByteForByteAndEveryWireBitFlipRefusesWithoutBurningReplayState() {
        val vectors = loadSharedVectors()
        val organisation = vectors.getValue("organisation")
        val discoveryBytes = decodeProximityHex(vectors.getValue("public_fixture_discovery_key"))
        val seedBytes = decodeProximityHex(vectors.getValue("public_fixture_device_seed"))
        val unixSeconds = vectors.getValue("unix_seconds").toLong()

        val sender = ProximityBeaconV2Sender(organisation, discoveryBytes, seedBytes)
        val first = sender.emitAt(unixSeconds)
        assertArrayEquals(decodeProximityHex(vectors.getValue("sequence_zero")), first.bytes())
        assertArrayEquals(
            decodeProximityHex(vectors.getValue("sequence_one")),
            sender.emitAt(unixSeconds).bytes(),
        )
        val nextWindowStart = ((unixSeconds / ProximityBeaconV2.ROTATION_WINDOW_SECONDS) + 1L) *
            ProximityBeaconV2.ROTATION_WINDOW_SECONDS
        assertArrayEquals(
            decodeProximityHex(vectors.getValue("next_window")),
            sender.emitAt(nextWindowStart).bytes(),
        )

        // Flip every single wire bit across all 27 * 8 = 216 bits and verify deterministic refusal.
        for (byteIndex in 0 until ProximityBeaconV2.WIRE_BYTES) {
            for (bit in 0 until 8) {
                val mutated = first.bytes()
                mutated[byteIndex] = (mutated[byteIndex].toInt() xor (1 shl bit)).toByte()
                val receiver = ProximityBeaconV2Receiver(organisation, discoveryBytes, capacity = 1)
                val expected = when {
                    byteIndex < 3 -> ProximityBeaconV2Error.INVALID_INPUT
                    byteIndex < 7 -> ProximityBeaconV2Error.EPOCH_MISMATCH
                    else -> ProximityBeaconV2Error.AUTHENTICATION_FAILED
                }
                try {
                    receiver.acceptAt(mutated, unixSeconds)
                    fail("Bit flip at byte=$byteIndex bit=$bit unexpectedly succeeded")
                } catch (failure: ProximityBeaconV2Failure) {
                    assertEquals("byte=$byteIndex bit=$bit", expected, failure.reason)
                }

                // Failed bit-flipped packet must never consume replay capacity or burn the genuine packet.
                val obs = receiver.acceptAt(first.bytes(), unixSeconds)
                assertEquals(0L, obs.sequence)
                try {
                    receiver.acceptAt(first.bytes(), unixSeconds)
                    fail("Replay after acceptance must fail")
                } catch (replay: ProximityBeaconV2Failure) {
                    assertEquals(ProximityBeaconV2Error.REPLAY, replay.reason)
                }
            }
        }
    }

    @Test
    fun graceWindowPeerCapacityForeignOrganisationClockRollbackAndHkdfDerivationEnforceBounds() {
        val orgA = "00000000-0000-4000-8000-000000000001"
        val orgB = "00000000-0000-4000-8000-000000000002"
        val rootMaterial = ByteArray(32) { (it + 7).toByte() }
        val derivedA = ProximityBeaconKeyDerivation.deriveKeys(orgA, rootMaterial, "device-alpha")
        val derivedB = ProximityBeaconKeyDerivation.deriveKeys(orgA, rootMaterial, "device-beta")
        assertArrayEquals(derivedA.discoveryKeyBytes(), derivedB.discoveryKeyBytes())
        assertFalse(derivedA.deviceSeedBytes().contentEquals(derivedB.deviceSeedBytes()))

        val senderA = ProximityBeaconV2Sender(orgA, derivedA.discoveryKeyBytes(), derivedA.deviceSeedBytes())
        val senderB = ProximityBeaconV2Sender(orgA, derivedB.discoveryKeyBytes(), derivedB.deviceSeedBytes())
        val receiver = ProximityBeaconV2Receiver(orgA, derivedA.discoveryKeyBytes(), capacity = 1)

        val p1 = senderA.emitAt(1_195L) // window 3
        // Accepted within 30s grace into window 4 (1200..1230).
        val obsGrace = receiver.acceptAt(p1.bytes(), 1_230L)
        assertEquals(3L, obsGrace.window)

        // Second peer in same retained grace window exceeds capacity=1.
        try {
            receiver.acceptAt(senderB.emitAt(1_200L).bytes(), 1_230L)
            fail("Expected capacity refusal")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.CAPACITY, failure.reason)
        }

        // Past 30s grace (1231s), window 3 packet is rejected as EPOCH_MISMATCH and evicted so senderB fits.
        try {
            receiver.acceptAt(p1.bytes(), 1_231L)
            fail("Expected expired grace refusal")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.EPOCH_MISMATCH, failure.reason)
        }
        val obsB = receiver.acceptAt(senderB.emitAt(1_231L).bytes(), 1_231L)
        assertNotEquals(obsGrace.pseudonymHex, obsB.pseudonymHex)

        // Foreign organisation with identical bytes refuses MAC verification.
        val foreignSender = ProximityBeaconV2Sender(orgB, derivedA.discoveryKeyBytes(), derivedA.deviceSeedBytes())
        try {
            receiver.acceptAt(foreignSender.emitAt(1_231L).bytes(), 1_231L)
            fail("Expected foreign org refusal")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.AUTHENTICATION_FAILED, failure.reason)
        }

        // Clock rollback refuses on both sender and receiver.
        try {
            senderA.emitAt(600L)
            fail("Expected sender rollback refusal")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.EPOCH_MISMATCH, failure.reason)
        }
        try {
            receiver.acceptAt(obsB.let { senderB.emitAt(1_232L).bytes() }, 900L)
            fail("Expected receiver rollback refusal")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.EPOCH_MISMATCH, failure.reason)
        }

        assertTrue(senderA.toString().contains("[redacted]"))
        assertTrue(receiver.toString().contains("[redacted]"))
        assertTrue(derivedA.toString().contains("[redacted]"))
        derivedA.close()
        derivedB.close()
        senderA.close()
        senderB.close()
        receiver.close()
    }

    @Test
    fun dutyCycleAndBatteryBudgetRefuseLowBatteryPowerSaverAndRapidScans() {
        val budget = ProximityDutyCycleBudget(
            maxScanWindowSeconds = 10L,
            minScanCooldownSeconds = 50L,
            maxBroadcastsPerRotationWindow = 3,
            minBatteryPercent = 15,
        )
        assertEquals(200, budget.activeDutyCyclePermille)

        val healthy = ProximityBatterySnapshot(batteryLevelPercent = 72, isPowerSaveMode = false)
        budget.validateScanStart(healthy, lastScanStartedAtUnixSeconds = null, nowUnixSeconds = 1_000L)

        // Rapid scan before 50s cooldown refuses as DUTY_CYCLE_THROTTLED.
        try {
            budget.validateScanStart(healthy, lastScanStartedAtUnixSeconds = 1_000L, nowUnixSeconds = 1_030L)
            fail("Expected duty-cycle throttle")
        } catch (failure: ProximityBeaconV2Failure) {
            assertEquals(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED, failure.reason)
        }

        // Low battery (< 15%) and Power Save mode refuse as BATTERY_BUDGET_EXCEEDED.
        for (lowPower in listOf(
            ProximityBatterySnapshot(batteryLevelPercent = 12, isPowerSaveMode = false),
            ProximityBatterySnapshot(batteryLevelPercent = 85, isPowerSaveMode = true),
        )) {
            try {
                budget.validateBroadcast(lowPower, emissionsInCurrentWindow = 0)
                fail("Expected battery refusal for $lowPower")
            } catch (failure: ProximityBeaconV2Failure) {
                assertEquals(ProximityBeaconV2Error.BATTERY_BUDGET_EXCEEDED, failure.reason)
            }
        }
    }
}

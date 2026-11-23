package io.kodera.android.domain

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class NativeCallRingTests {
    private fun vectors(): List<List<String>> {
        val relative = "packages/kodera-rs/vectors/mobile-call-wake-v1.txt"
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, relative).isFile }
        return File(root, relative).readLines().filter { !it.startsWith("#") }.map { it.split("|", limit = 3) }
    }
    @Test fun sharedStrictWireVectorsThroughPacketBinding() {
        vectors().forEach { (ok, now, raw) ->
            assertEquals(raw, ok == "1", runCatching { NativeCallWake.admit(raw.toByteArray(), now.toLong()) }.isSuccess)
        }
    }
    @Test fun cancelBeforeRingAndClockRollbackNeverReopen() {
        val ring = NativeCallWake.admit(vectors()[0][2].toByteArray(), 100)
        val cancel = ring.copy(epoch = 2, state = NativeRingPhase.ANSWERED_ELSEWHERE)
        val machine = NativeCallRing(ring.organisationId)
        machine.observe(cancel, 100)
        assertThrows(KoderaMobileFfiFailure::class.java) { machine.observe(ring, 101) }
        assertEquals(NativeRingPhase.ANSWERED_ELSEWHERE, machine.records[ring.callId]?.phase)
        assertFalse(machine.records[ring.callId]!!.missed)
        machine.revoke(); assertTrue(machine.records.isEmpty())
        machine.observe(ring, 101)
        assertThrows(KoderaMobileFfiFailure::class.java) { machine.observe(cancel, 100) }
        machine.transition(ring.callId, NativeRingPhase.CONNECTING); machine.transition(ring.callId, NativeRingPhase.CONNECTED)
        machine.tick(140); assertEquals(NativeRingPhase.CONNECTED, machine.records[ring.callId]?.phase)
    }
    @Test fun delayedAnswerClearsExpiredMissedState() {
        val wake = NativeCallWake.admit(vectors()[0][2].toByteArray(), 100)
        val machine = NativeCallRing(wake.organisationId)
        machine.observe(wake, 100); machine.tick(130); assertTrue(machine.records[wake.callId]!!.missed)
        machine.observe(wake.copy(epoch = 2, state = NativeRingPhase.ANSWERED_ELSEWHERE, expiresAt = 150), 131)
        assertEquals(NativeRingPhase.ANSWERED_ELSEWHERE, machine.records[wake.callId]?.phase)
        assertFalse(machine.records[wake.callId]!!.missed)
    }
    @Test fun capacityNeverEvictsLiveTombstones() {
        val wake = NativeCallWake.admit(vectors()[0][2].toByteArray(), 100).copy(state = NativeRingPhase.ENDED)
        val machine = NativeCallRing(wake.organisationId)
        for (i in 1..128) machine.observe(wake.copy(callId = "11111111-1111-4111-8111-%012x".format(i)), 100)
        assertThrows(KoderaMobileFfiFailure::class.java) { machine.observe(wake, 100) }
        assertEquals(128, machine.records.size)
    }
}

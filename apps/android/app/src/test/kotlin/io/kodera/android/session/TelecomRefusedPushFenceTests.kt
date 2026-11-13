package io.kodera.android.session

import io.kodera.android.domain.CallEndReason
import io.kodera.android.domain.CallRejectionReason
import io.kodera.android.domain.CallWakeupFailure
import io.kodera.android.domain.IncomingCallWakeup
import io.kodera.android.domain.TelecomCallPhase
import io.kodera.android.domain.VerifiedCallDescriptor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class TelecomRefusedPushFenceTests(private val stage: String, private val payloadKind: String) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}-{1}")
        fun cases(): Collection<Array<Any>> = listOf("pending", "ringing", "connecting", "connected", "held").flatMap { stage ->
            listOf("malformed", "cleartext", "busy-replay").map { kind -> arrayOf<Any>(stage, kind) }
        }
    }

    private val org = "11111111-2222-4333-8444-555555555555"
    private val wakeupId = "22222222-3333-4444-8555-666666666666"
    private val roomHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    private val epoch = 1_762_992_000_000L

    private class Driver : TelecomConnectionDriver {
        var visible: String? = null
        val ended = mutableListOf<String>()
        val answered = mutableListOf<String>()
        val rejected = mutableListOf<String?>()
        override fun onIncomingCallRinging(wakeup: IncomingCallWakeup, descriptor: VerifiedCallDescriptor) { visible = wakeup.connectionId }
        override fun onCallAnswered(connectionId: String) { answered += connectionId }
        override fun onCallEnded(connectionId: String, reason: CallEndReason) { ended += connectionId; if (visible == connectionId) visible = null }
        override fun onCallRejected(connectionId: String?, reason: CallRejectionReason) {
            rejected += connectionId
            if (visible == connectionId) visible = null
        }
    }

    private fun payload(cleartext: Boolean = false): ByteArray {
        val extra = if (cleartext) ",\"caller_name\":\"untrusted relay text\"" else ""
        return """{"wakeup_id":"$wakeupId","org_id":"$org","room_hash":"$roomHash","epoch_ms":$epoch,"transport":"fcm"$extra}"""
            .toByteArray(Charsets.UTF_8)
    }

    @Test
    fun rejectedWakeupPreservesTheExistingCallAndItsNativeControls() {
        val driver = Driver()
        val resolver = AuthenticatedCallDescriptorResolver { wakeup ->
            VerifiedCallDescriptor.create(wakeup.wakeupId, wakeup.organisationId, "synthetic-room", roomHash, "Synthetic caller", false)
        }
        val coordinator = TelecomPushCoordinator(driver, if (stage == "pending") null else resolver)
        coordinator.configureOrganisation(org)
        val wakeup = coordinator.admitPayloadFreePush(payload(), nowEpochMs = epoch + 1_000)
        if (stage in listOf("connecting", "connected", "held")) coordinator.answerCall()
        if (stage in listOf("connected", "held")) coordinator.markConnected()
        if (stage == "held") coordinator.setHeld(true)
        val before = coordinator.phase
        val nativeBefore = driver.visible
        val rejected = when (payloadKind) {
            "malformed" -> "{not-json".toByteArray()
            "cleartext" -> payload(cleartext = true)
            else -> payload()
        }
        assertThrows(CallWakeupFailure::class.java) { coordinator.admitPayloadFreePush(rejected, nowEpochMs = epoch + 2_000) }
        assertEquals(before, coordinator.phase)
        assertEquals(nativeBefore, driver.visible)
        assertTrue(driver.ended.isEmpty())
        assertTrue(driver.rejected.isEmpty())
        assertEquals(1, coordinator.rejectedPushCount)
        if (stage == "pending") {
            coordinator.attachVerifiedDescriptor(resolver.resolve(wakeup))
            coordinator.answerCall()
        } else if (stage == "ringing") coordinator.answerCall()
        if (stage in listOf("pending", "ringing", "connecting")) coordinator.markConnected()
        if (stage == "held") coordinator.setHeld(false)
        coordinator.setMuted(true)
        coordinator.endCall(CallEndReason.LOCAL_HANGUP)
        assertEquals(listOf(wakeupId), driver.ended)
        assertNull(driver.visible)
        assertTrue(coordinator.phase is TelecomCallPhase.Ended)
    }
}

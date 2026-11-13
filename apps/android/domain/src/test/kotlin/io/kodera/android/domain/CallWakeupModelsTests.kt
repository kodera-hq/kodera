package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CallWakeupModelsTests {
    private val orgA = "00000000-0000-4000-8000-000000000001"
    private val orgB = "00000000-0000-4000-8000-000000000002"
    private val wakeupOne = "11111111-2222-4333-8444-555555555555"
    private val wakeupTwo = "66666666-7777-4888-8999-aaaaaaaaaaaa"

    @Test
    fun payloadFreeUnifiedPushAndFcmEnvelopesAdmitOnlyOpaqueIdentifiers() {
        val unifiedPushJson = """
            {
              "wakeup_id": "$wakeupOne",
              "org_id": "$orgA",
              "room_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015",
              "epoch_ms": 1700000000123,
              "transport": "unifiedpush"
            }
        """.trimIndent()
        val result = PayloadFreePushEnvelope.admit(unifiedPushJson)
        assertTrue(result.strippedFieldNames.isEmpty())
        assertEquals(wakeupOne, result.envelope.wakeupId)
        assertEquals(orgA, result.envelope.orgId)
        assertEquals("sha256:9f86d081884c7d659a2feaa0c55ad015", result.envelope.roomHash)
        assertEquals(1_700_000_000_123L, result.envelope.epochMs)
        assertEquals(PushRelayTransport.UNIFIED_PUSH, result.envelope.transport)

        val fcmWrappedJson = """
            {
              "data": {
                "wakeup_id": "$wakeupTwo",
                "organisation_id": "$orgA",
                "sync_hint": "room_opaque_01",
                "epoch_ms": "1700000000999",
                "transport": "fcm"
              }
            }
        """.trimIndent()
        val fcmResult = PayloadFreePushEnvelope.admit(fcmWrappedJson)
        assertEquals(wakeupTwo, fcmResult.envelope.wakeupId)
        assertEquals(orgA, fcmResult.envelope.organisationId)
        assertEquals("room_opaque_01", fcmResult.envelope.syncHint)
        assertEquals(1_700_000_000_999L, fcmResult.envelope.epochMs)
        assertEquals(PushRelayTransport.FCM, fcmResult.envelope.transport)
    }

    @Test
    fun pushEnvelopesCarryingCleartextCallerRoomOrMessageFieldsAreRejected() {
        val cleartextSamples = listOf(
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"title":"Incoming call"}""",
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"caller_name":"Alice"}""",
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"room_title":"Strategy"}""",
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"body":"Hello team"}""",
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"notification":{"body":"Leak"}}""",
            """{"data":{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":"1700000000000","sdp":"v=0"}}""",
            """{"wakeup_id":"$wakeupOne","org_id":"$orgA","room_hash":"h1","epoch_ms":1700000000000,"\u0074itle":"Escaped title"}""",
        )

        for (sample in cleartextSamples) {
            try {
                PayloadFreePushEnvelope.admit(sample)
                fail("Expected cleartext refusal for: $sample")
            } catch (failure: CallWakeupFailure) {
                assertEquals(sample, CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN, failure.reason)
            }
        }
    }

    @Test
    fun telecomStateMachineTransitionsThroughAllPhasesAndGuardsReplayAndOrgSwitch() {
        val state = CallSessionState(organisationId = orgA)
        assertEquals(TelecomCallPhase.Idle, state.phase)

        val envelope = PayloadFreePushEnvelope.create(
            wakeupId = wakeupOne,
            organisationId = orgA,
            roomHash = "opaque_room_7",
            epochMs = 1_700_000_000_000L,
        )
        val wakeup = IncomingCallWakeup(envelope)
        state.admitWakeup(wakeup, nowEpochMs = 1_700_000_005_000L)
        assertTrue(state.phase is TelecomCallPhase.WakeupPending)
        assertEquals(wakeupOne, state.activeConnectionId)

        val descriptor = VerifiedCallDescriptor.create(
            wakeupId = wakeupOne,
            organisationId = orgA,
            roomId = "!room7:community.kodera.io",
            liveKitRoomName = "lk_room_7",
            callerLabel = "Design Partner Room",
            hasVideo = false,
        )
        state.attachVerifiedDescriptor(descriptor)
        assertTrue(state.phase is TelecomCallPhase.Ringing)

        state.acceptAnswer()
        assertTrue(state.phase is TelecomCallPhase.Connecting)

        state.markConnected()
        assertTrue(state.phase is TelecomCallPhase.Connected)
        assertFalse(state.isMuted)
        assertFalse(state.isHeld)
        assertEquals(CallAudioRoute.EARPIECE, state.audioRoute)

        state.setMuted(true)
        assertTrue(state.isMuted)

        state.setAudioRoute(CallAudioRoute.SPEAKER)
        assertEquals(CallAudioRoute.SPEAKER, state.audioRoute)

        state.setHeld(true)
        assertTrue(state.phase is TelecomCallPhase.OnHold)
        assertTrue(state.isHeld)

        state.setHeld(false)
        assertTrue(state.phase is TelecomCallPhase.Connected)
        assertFalse(state.isHeld)

        state.endCall(CallEndReason.LOCAL_HANGUP)
        assertEquals(TelecomCallPhase.Ended(CallEndReason.LOCAL_HANGUP), state.phase)
        assertNull(state.activeConnectionId)

        // Replaying the exact same wakeup ID is rejected.
        try {
            state.admitWakeup(wakeup, nowEpochMs = 1_700_000_010_000L)
            fail("Expected replay refusal")
        } catch (failure: CallWakeupFailure) {
            assertEquals(CallWakeupError.REPLAY_WAKEUP, failure.reason)
            assertEquals(TelecomCallPhase.Rejected(CallRejectionReason.REPLAY_WAKEUP), state.phase)
        }

        // Switching organisation ends active calls and isolates wakeup state.
        val secondWakeup = IncomingCallWakeup(
            PayloadFreePushEnvelope.create(wakeupTwo, orgA, "opaque_room_8", 1_700_000_020_000L)
        )
        state.admitWakeup(secondWakeup, nowEpochMs = 1_700_000_020_000L)
        state.configureOrganisation(orgB)
        assertEquals(TelecomCallPhase.Ended(CallEndReason.ORGANISATION_CHANGED), state.phase)
    }
}

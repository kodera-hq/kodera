package io.kodera.android.session

import io.kodera.android.client.AuthenticatedNativeCall
import io.kodera.android.client.AttachmentUploadPayload
import io.kodera.android.client.BootstrappedMatrixRoom
import io.kodera.android.client.ChannelConversationTransport
import io.kodera.android.client.LiveKitWebRTCSession
import io.kodera.android.client.MatrixClientError
import io.kodera.android.client.MatrixClientException
import io.kodera.android.client.MatrixRawTimelineEvent
import io.kodera.android.client.MatrixRoomSyncDelta
import io.kodera.android.client.MatrixSyncBatch
import io.kodera.android.client.NativeCallCoordinator
import io.kodera.android.client.NativeCallResolver
import io.kodera.android.domain.AttachmentMetadataRef
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.domain.NativeCallWake
import io.kodera.android.domain.NativeRingPhase
import org.junit.Assert.*
import org.junit.Test

private const val ORG = "11111111-1111-4111-8111-111111111111"
private const val CHANNEL = "22222222-2222-4222-8222-222222222222"
private const val CALL = "33333333-3333-4333-8333-333333333333"
private const val ROOM = "!audio:example.org"

class NativeCallConversationTests {
    @Test fun liveConversationRevokesRingingAndConnectedCallsAtAuthorityAndSecurityBoundaries() {
        for (connected in listOf(false, true)) {
            for (boundary in listOf("answer", "leave", "plaintext", "notFound", "forbidden", "backfill", "confidential", "unknown")) {
                val transport = ConversationCallTransport(); val media = ConversationCallMedia()
                val coordinator = NativeCallCoordinator(ORG, "local", NativeCallResolver {
                    AuthenticatedNativeCall(it, ROOM, "Member")
                }, media, transport, { 100 })
                val controller = ChannelConversationController(
                    scope = scope(), transport = transport,
                    onAuthenticatedSync = { roomId, batch -> coordinator.consumeAuthenticatedSync(batch, roomId) },
                    onTransportFailure = coordinator::consumeTransportFailure,
                    onSecurityBoundaryChanged = coordinator::revoke,
                )
                coordinator.receive(NativeCallWake(CALL, ORG, CHANNEL, 1, NativeRingPhase.RINGING, 130))
                controller.bootstrap()
                if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
                assertNotNull(coordinator.currentCall())
                when (boundary) {
                    "confidential", "unknown" -> controller.updateChannelSecurity(if (boundary == "confidential") true else null)
                    "notFound", "forbidden" -> {
                        transport.failure = if (boundary == "notFound") MatrixClientError.NOT_FOUND else MatrixClientError.FORBIDDEN
                        controller.refreshSync()
                    }
                    "backfill" -> {
                        transport.batch = MatrixSyncBatch.fromDeltas("limited", mapOf(ROOM to MatrixRoomSyncDelta(emptyList(), limited = true, prevBatch = "previous"))).copy(plaintextAllowedRooms = setOf(ROOM))
                        transport.backfillFailure = MatrixClientError.FORBIDDEN
                        controller.refreshSync()
                    }
                    else -> {
                        transport.batch = when (boundary) {
                            "answer" -> MatrixSyncBatch("answer", mapOf(ROOM to listOf(MatrixRawTimelineEvent(
                                type = "m.call.answer", eventId = "\$answer", sender = transport.ownUserId,
                                originServerTs = 100, callId = CALL, callPartyId = "other",
                            ))), plaintextAllowedRooms = setOf(ROOM))
                            "leave" -> MatrixSyncBatch("left", emptyMap(), authorityLostRooms = setOf(ROOM))
                            else -> MatrixSyncBatch("blocked", emptyMap())
                        }
                        controller.refreshSync()
                    }
                }
                assertNull(boundary, coordinator.currentCall()); assertEquals(boundary, 1, media.disconnects)
                assertFalse(boundary, media.microphoneEnabled)
                assertEquals(boundary, if (boundary == "answer") NativeRingPhase.ANSWERED_ELSEWHERE else null, coordinator.phase(CALL))
                controller.clear()
            }
        }
    }

    @Test fun bootstrapFailuresReachOwnerAndClearedConsumersCannotRevokeLaterCalls() {
        val transport = ConversationCallTransport()
        val failures = mutableListOf<MatrixClientError>(); var syncs = 0; var securityChanges = 0
        val controller = ChannelConversationController(scope(), transport,
            onAuthenticatedSync = { _, _ -> syncs++ },
            onTransportFailure = { failures += it.reason },
            onSecurityBoundaryChanged = { securityChanges++ },
        )
        transport.failure = MatrixClientError.NOT_FOUND
        controller.bootstrap(); assertEquals(listOf(MatrixClientError.NOT_FOUND), failures)
        transport.failure = null; controller.bootstrap(); assertEquals(1, syncs)
        controller.clear(); controller.refreshSync(); controller.updateChannelSecurity(true)
        assertEquals(1, syncs); assertEquals(0, securityChanges)
    }

    private fun scope() = ChannelConversationScope(ORG, CHANNEL, "audio", "", ChannelKind.AUDIO, ChannelRoomState.READY, false)
}

private class ConversationCallMedia : LiveKitWebRTCSession {
    var disconnects = 0; var microphoneEnabled = false
    override fun connect(call: AuthenticatedNativeCall) {}
    override fun microphone(enabled: Boolean) { microphoneEnabled = enabled }
    override fun audioSession(active: Boolean) {}
    override fun networkPathChanged() {}
    override fun disconnect() { disconnects++; microphoneEnabled = false }
}

private class ConversationCallTransport : ChannelConversationTransport {
    override val ownUserId = "@member:example.org"
    var backfillFailure: MatrixClientError? = null
    override fun backfillRoomMessages(roomId: String, fromToken: String, limit: Int): List<MatrixRawTimelineEvent> {
        backfillFailure?.let { throw MatrixClientException(it) }
        return emptyList()
    }
    var failure: MatrixClientError? = null
    var batch = MatrixSyncBatch("s", emptyMap(), plaintextAllowedRooms = setOf(ROOM))
    override fun bootstrapRoom(organisationId: String, channelId: String): BootstrappedMatrixRoom {
        failure?.let { throw MatrixClientException(it) }
        return BootstrappedMatrixRoom(ROOM, batch)
    }
    override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch {
        failure?.let { throw MatrixClientException(it) }
        return batch
    }
    override fun sendMessage(roomId: String, transactionId: String, body: String, replyToEventId: String?, attachments: List<AttachmentMetadataRef>) = "\$sent"
    override fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String) = "\$edit"
    override fun redactEvent(roomId: String, transactionId: String, targetEventId: String) = "\$redacted"
    override fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String) = "\$reaction"
    override fun uploadAttachment(organisationId: String, channelId: String, payload: AttachmentUploadPayload): AttachmentMetadataRef = error("unused")
}

package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

private const val ORG = "22222222-2222-4222-8222-222222222222"
private const val CALL = "11111111-1111-4111-8111-111111111111"
private const val CHANNEL = "33333333-3333-4333-8333-333333333333"
private fun wake(state: NativeRingPhase = NativeRingPhase.RINGING, epoch: Long = 1) = NativeCallWake(CALL, ORG, CHANNEL, epoch, state, 130)
private open class MediaFixture : LiveKitWebRTCSession {
    val connects = AtomicInteger(); val disconnects = AtomicInteger(); val networks = AtomicInteger()
    var microphone = false
    override fun connect(call: AuthenticatedNativeCall) { connects.incrementAndGet() }
    override fun disconnect() { disconnects.incrementAndGet(); microphone = false }
    override fun microphone(enabled: Boolean) { microphone = enabled }
    override fun audioSession(active: Boolean) {}
    override fun networkPathChanged() { networks.incrementAndGet() }
}
private class ChatFixture : ChannelConversationTransport {
    override val ownUserId = "@member:example.org"
    var refuse = false
    var events = emptyList<MatrixRawTimelineEvent>()
    var lostRooms = emptySet<String>()
    var syncFailure: MatrixClientError? = null
    override fun bootstrapRoom(organisationId: String, channelId: String) = BootstrappedMatrixRoom("!room:example.org", MatrixSyncBatch("one", emptyMap(), plaintextAllowedRooms = setOf("!room:example.org")))
    override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch {
        syncFailure?.let { throw MatrixClientException(it) }
        return MatrixSyncBatch("two", mapOf(roomId to events), plaintextAllowedRooms = setOf(roomId), authorityLostRooms = lostRooms)
    }
    override fun sendMessage(roomId: String, transactionId: String, body: String, replyToEventId: String?, attachments: List<AttachmentMetadataRef>): String {
        check(!refuse); return "\$sent"
    }
    override fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String) = "\$edited"
    override fun redactEvent(roomId: String, transactionId: String, targetEventId: String) = "\$redacted"
    override fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String) = "\$reaction"
    override fun uploadAttachment(organisationId: String, channelId: String, payload: AttachmentUploadPayload): AttachmentMetadataRef = error("unavailable")
}
private class PresenterFixture : NativeCallPresenter {
    val reasons = mutableListOf<NativeRingPhase>(); var metadata = 0
    override fun ringing(call: AuthenticatedNativeCall) { metadata++ }
    override fun connected(callId: String) {}
    override fun ended(callId: String, reason: NativeRingPhase) { reasons += reason }
}
class NativeCallCoordinatorTests {
    private fun resolver() = NativeCallResolver { AuthenticatedNativeCall(it, "!room:example.org", "Member") }
    @Test fun cancellationDuringLookupFencesLateMetadataAndMedia() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val failure = AtomicReference<Throwable?>()
        val media = MediaFixture(); val presenter = PresenterFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", NativeCallResolver {
            entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); AuthenticatedNativeCall(it, "!room:example.org", "Member")
        }, media, ChatFixture(), { 100 })
        coordinator.bind(presenter)
        val thread = Thread { try { coordinator.receive(wake()) } catch (error: Throwable) { failure.set(error) } }
        thread.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS)); coordinator.receive(wake(NativeRingPhase.ANSWERED_ELSEWHERE, 2))
        } finally { release.countDown(); thread.join(5000) }
        assertFalse(thread.isAlive); assertNull(failure.get()); assertNull(coordinator.currentCall())
        assertEquals(0, media.connects.get()); assertEquals(0, presenter.metadata)
        assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
    }
    @Test fun mediaWaitsForAudioFocusAndChatSyncDeduplicatesOtherDeviceOnly() {
        val media = MediaFixture(); val chat = ChatFixture(); val presenter = PresenterFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.bind(presenter); coordinator.receive(wake()); coordinator.answer(CALL)
        assertFalse(media.microphone); coordinator.audioSession(true); assertTrue(media.microphone)
        coordinator.setMuted(true); assertFalse(media.microphone)
        coordinator.networkPathChanged(); assertEquals(1, media.networks.get())
        assertEquals("\$sent", coordinator.sendCompanionMessage("Companion message"))
        val same = MatrixRawTimelineEvent("m.call.answer", "\$one", chat.ownUserId, 100000, callId = CALL, callPartyId = "local")
        chat.events = listOf(same); coordinator.syncCompanionTimeline(null); assertNotNull(coordinator.currentCall())
        chat.events = listOf(same.copy(callPartyId = "other")); coordinator.syncCompanionTimeline("one")
        assertNull(coordinator.currentCall()); assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
    }
    @Test fun unauthorizedResolutionClearsTransientStateWithoutMedia() {
        val media = MediaFixture(); val presenter = PresenterFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", NativeCallResolver { error("not found") }, media, ChatFixture(), { 100 })
        coordinator.bind(presenter)
        assertThrows(IllegalStateException::class.java) { coordinator.receive(wake()) }
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL))
        assertEquals(0, media.connects.get()); assertEquals(listOf(NativeRingPhase.REVOKED), presenter.reasons)
    }
    @Test fun membershipLossInSyncRevokesOnlyTheCallsRoom() {
        val media = MediaFixture(); val chat = ChatFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.receive(wake()); coordinator.answer(CALL)
        chat.lostRooms = setOf("!unrelated:example.org"); coordinator.syncCompanionTimeline("one")
        assertNotNull(coordinator.currentCall())
        chat.lostRooms = setOf("!room:example.org"); coordinator.syncCompanionTimeline("two")
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertEquals(1, media.disconnects.get())
    }
    @Test fun syncNotFoundAndForbiddenWipeMedia() {
        for (failure in listOf(MatrixClientError.NOT_FOUND, MatrixClientError.FORBIDDEN)) {
            val media = MediaFixture(); val chat = ChatFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
            coordinator.receive(wake()); coordinator.answer(CALL); chat.syncFailure = failure
            assertThrows(MatrixClientException::class.java) { coordinator.syncCompanionTimeline("one") }
            assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertEquals(1, media.disconnects.get())
        }
    }
    @Test fun liveSyncPlaintextExclusionRevokesRingingAndConnectedCalls() {
        for (connected in listOf(false, true)) {
            val media = MediaFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
            coordinator.bind(presenter); coordinator.receive(wake())
            if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
            coordinator.consumeAuthenticatedSync(MatrixSyncBatch("other", mapOf("!other:example.org" to emptyList())), "!other:example.org")
            assertNotNull(coordinator.currentCall())
            coordinator.consumeAuthenticatedSync(MatrixSyncBatch("blocked", emptyMap()), "!room:example.org")
            assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertFalse(media.microphone)
            assertEquals(1, media.disconnects.get()); assertEquals(listOf(NativeRingPhase.REVOKED), presenter.reasons)
        }
    }
    @Test fun liveAuthorityFailuresAndLateCancellationWakesAreSafe() {
        for (failure in listOf(MatrixClientError.NOT_FOUND, MatrixClientError.FORBIDDEN, MatrixClientError.UNAUTHORIZED,
            MatrixClientError.PLAINTEXT_FORBIDDEN, MatrixClientError.PROTOCOL_VIOLATION, MatrixClientError.IDENTITY_UNAVAILABLE)) {
            val media = MediaFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
            coordinator.bind(presenter); coordinator.receive(wake()); coordinator.answer(CALL)
            coordinator.consumeTransportFailure(MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE))
            assertNotNull(coordinator.currentCall())
            coordinator.consumeTransportFailure(MatrixClientException(failure))
            coordinator.receive(wake(NativeRingPhase.ANSWERED_ELSEWHERE, 2))
            coordinator.receive(wake(NativeRingPhase.ENDED, 3)); coordinator.receive(wake(epoch = 4))
            assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL))
            assertEquals(1, media.disconnects.get()); assertEquals(listOf(NativeRingPhase.REVOKED), presenter.reasons)
        }
    }
    @Test fun audioFocusRevocationDiscardsLateCancellationWakes() {
        val media = MediaFixture(); val presenter = PresenterFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
        coordinator.bind(presenter); coordinator.receive(wake()); coordinator.answer(CALL); coordinator.audioSession(true)
        coordinator.revoke()
        coordinator.receive(wake(NativeRingPhase.ANSWERED_ELSEWHERE, 2)); coordinator.receive(wake(NativeRingPhase.ENDED, 3))
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertFalse(media.microphone)
        assertEquals(listOf(NativeRingPhase.REVOKED), presenter.reasons); assertEquals(1, media.disconnects.get())
    }
    @Test fun replayAndCapacityRejectionsPreserveTheActiveCall() {
        for (connected in listOf(false, true)) {
            val media = MediaFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
            coordinator.bind(presenter); coordinator.receive(wake())
            if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
            val before = coordinator.phase(CALL)
            coordinator.receive(wake()); coordinator.receive(wake(epoch = 2))
            coordinator.receive(wake().copy(callId = "44444444-4444-4444-8444-444444444444"))
            assertEquals(before, coordinator.phase(CALL)); assertNotNull(coordinator.currentCall())
            assertEquals(0, media.disconnects.get()); assertTrue(presenter.reasons.isEmpty())
            if (connected) assertTrue(media.microphone) else coordinator.answer(CALL)
            coordinator.end(CALL); assertEquals(listOf(NativeRingPhase.ENDED), presenter.reasons)
        }
    }
    @Test fun retirementWhileConnectOpensClosesTheLateSession() {
        for (revoked in listOf(false, true)) {
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val open = java.util.concurrent.atomic.AtomicBoolean(false)
            val failure = AtomicReference<Throwable?>()
            val media = object : MediaFixture() {
                override fun connect(call: AuthenticatedNativeCall) {
                    entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); open.set(true)
                }
                override fun disconnect() { super.disconnect(); open.set(false) }
            }
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
            coordinator.receive(wake())
            val answering = Thread { try { coordinator.answer(CALL) } catch (error: Throwable) { failure.set(error) } }
            answering.start()
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                if (revoked) coordinator.revoke() else coordinator.end(CALL)
                assertNull(coordinator.currentCall())
            } finally { release.countDown(); answering.join(5000) }
            assertFalse(answering.isAlive); assertNull(failure.get()); assertFalse(open.get())
            assertFalse(media.microphone); assertEquals(2, media.disconnects.get())
        }
    }
    @Test fun obsoleteAudioHandoffDoesNotActivateOrAnswerTheNextCall() {
        val media = MediaFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
        coordinator.receive(wake()); val owner = coordinator.ownership(CALL)!!; coordinator.end(CALL)
        val nextId = "44444444-4444-4444-8444-444444444444"
        coordinator.receive(wake().copy(callId = nextId))
        coordinator.answer(CALL, expectedOwner = owner, activateAudio = true)
        assertEquals(nextId, coordinator.currentCall()?.wake?.callId)
        assertEquals(NativeRingPhase.RINGING, coordinator.phase(nextId)); assertEquals(0, media.connects.get()); assertFalse(media.microphone)
        coordinator.answer(nextId); assertFalse(media.microphone)
    }
    @Test fun lateRetiredConnectClosesBeforeTheNextSessionOpens() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val nextStarted = CountDownLatch(1)
        val open = AtomicReference<String?>(); val failure = AtomicReference<Throwable?>()
        val media = object : MediaFixture() {
            override fun connect(call: AuthenticatedNativeCall) {
                if (call.wake.callId == CALL) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                open.set(call.wake.callId)
            }
            override fun disconnect() { super.disconnect(); open.set(null) }
        }
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { 100 })
        coordinator.receive(wake())
        val first = Thread { try { coordinator.answer(CALL) } catch (error: Throwable) { failure.set(error) } }
        val nextId = "44444444-4444-4444-8444-444444444444"
        val second = Thread { try { nextStarted.countDown(); coordinator.answer(nextId) } catch (error: Throwable) { failure.set(error) } }
        first.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS)); coordinator.end(CALL)
            coordinator.receive(wake().copy(callId = nextId)); second.start()
            assertTrue(nextStarted.await(5, TimeUnit.SECONDS)); assertNull(open.get())
        } finally { release.countDown(); first.join(5000); if (second.state != Thread.State.NEW) second.join(5000) }
        assertFalse(first.isAlive); assertFalse(second.isAlive); assertNull(failure.get())
        assertEquals(nextId, open.get()); assertEquals(NativeRingPhase.CONNECTED, coordinator.phase(nextId))
    }
    @Test fun lostAuthorityWipesCallAndFailsClosed() {
        val media = MediaFixture(); val chat = ChatFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.receive(wake()); coordinator.answer(CALL); chat.refuse = true
        assertThrows(IllegalStateException::class.java) { coordinator.sendCompanionMessage("Denied") }
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertEquals(1, media.disconnects.get())
        coordinator.receive(wake())
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertEquals(1, media.connects.get())
    }
}

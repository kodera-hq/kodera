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
private class MediaFixture : LiveKitWebRTCSession {
    val connects = AtomicInteger(); val disconnects = AtomicInteger(); val networks = AtomicInteger()
    var microphone = false
    override fun connect(call: AuthenticatedNativeCall) { connects.incrementAndGet() }
    override fun disconnect() { disconnects.incrementAndGet() }
    override fun microphone(enabled: Boolean) { microphone = enabled }
    override fun audioSession(active: Boolean) {}
    override fun networkPathChanged() { networks.incrementAndGet() }
}
private class ChatFixture : ChannelConversationTransport {
    override val ownUserId = "@member:example.org"
    var refuse = false
    var events = emptyList<MatrixRawTimelineEvent>()
    override fun bootstrapRoom(organisationId: String, channelId: String) = BootstrappedMatrixRoom("!room:example.org", MatrixSyncBatch("one", emptyMap()))
    override fun syncRoom(roomId: String, since: String?) = MatrixSyncBatch("two", mapOf(roomId to events))
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
    @Test fun lostAuthorityWipesCallAndFailsClosed() {
        val media = MediaFixture(); val chat = ChatFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.receive(wake()); coordinator.answer(CALL); chat.refuse = true
        assertThrows(IllegalStateException::class.java) { coordinator.sendCompanionMessage("Denied") }
        assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL)); assertEquals(1, media.disconnects.get())
        assertThrows(IllegalStateException::class.java) { coordinator.receive(wake()) }
    }
}

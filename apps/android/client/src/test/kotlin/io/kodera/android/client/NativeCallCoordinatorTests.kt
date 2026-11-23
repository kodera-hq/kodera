package io.kodera.android.client

import io.kodera.android.domain.*
import okhttp3.HttpUrl.Companion.toHttpUrl
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
    var limitedRooms = emptySet<String>()
    var recoveryBatch: MatrixSyncBatch? = null
    var initialBatch: MatrixSyncBatch? = null
    var beforeBackfill: (() -> Unit)? = null
    var prevBatch: String? = null
    var pages = emptyMap<String, MatrixTimelinePage>()
    var pageFailure: MatrixClientError? = null
    val pageRequests = mutableListOf<String>()
    override fun backfillRoomPage(roomId: String, fromToken: String, toToken: String?, limit: Int): MatrixTimelinePage {
        pageRequests += "$roomId|$fromToken|${toToken ?: "nil"}|$limit"
        beforeBackfill?.invoke()
        pageFailure?.let { throw MatrixClientException(it) }
        return pages[fromToken] ?: MatrixTimelinePage(emptyList(), null)
    }
    var beforeSync: (() -> Unit)? = null
    val syncRequests = java.util.concurrent.CopyOnWriteArrayList<String?>()
    override fun bootstrapRoom(organisationId: String, channelId: String) = BootstrappedMatrixRoom("!room:example.org", initialBatch ?: MatrixSyncBatch("one", emptyMap(), plaintextAllowedRooms = setOf("!room:example.org")))
    override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch {
        syncRequests += since
        beforeSync?.invoke()
        syncFailure?.let { throw MatrixClientException(it) }
        if (since == null) recoveryBatch?.let { return it }
        val deltas = limitedRooms.associateWith { MatrixRoomSyncDelta(emptyList(), limited = true) }.toMutableMap()
        deltas[roomId] = MatrixRoomSyncDelta(events, limited = roomId in limitedRooms, prevBatch = prevBatch)
        return MatrixSyncBatch.fromDeltas("two", deltas).copy(plaintextAllowedRooms = setOf(roomId), authorityLostRooms = lostRooms)
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
    val lifecycle = mutableListOf<String>()
    var onEnded: (() -> Unit)? = null
    override fun ringing(call: AuthenticatedNativeCall) { metadata++; lifecycle += "ring:${call.wake.callId}" }
    override fun connected(callId: String) {}
    override fun ended(callId: String, reason: NativeRingPhase) { reasons += reason; lifecycle += "end:$callId:$reason"; onEnded?.invoke() }
}
class NativeCallCoordinatorTests {
    private fun resolver() = NativeCallResolver { AuthenticatedNativeCall(it, "!room:example.org", "Member") }
    @Test fun overlappingMatrixReadersRecoverRoomKnowledgeBeforeUsingQueuedCursor() {
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val cursors = java.util.concurrent.CopyOnWriteArrayList<String?>()
            val count = AtomicInteger()
            val state = """{"next_batch":"known","rooms":{"join":{"!room:example.org":{"state":{"events":[]},"timeline":{"events":[]}}}}}""".toByteArray()
            val stub = MatrixHttpStub { request ->
                cursors += request.url.toHttpUrl().queryParameter("since")
                if (count.incrementAndGet() == 2) {
                    entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); MatrixHttpReply(503)
                } else MatrixHttpReply(200, state)
            }
            MatrixRoomClient(requester, LoopbackPolicy.REFUSE, httpStub = stub).use { client ->
                val origin = "https://atelier.matrix.kodera.io"; val room = "!room:example.org"
                client.bindChannelSecurity(ORG, CHANNEL, origin, room, false)
                client.sync(origin, "token", roomId = room)
                val failure = AtomicReference<Throwable?>(); val result = AtomicReference<MatrixSyncBatch?>()
                val ui = Thread { failure.set(assertThrows(MatrixClientException::class.java) { client.sync(origin, "token", roomId = room) }) }
                val companion = Thread { try { result.set(client.sync(origin, "token", since = "stale", roomId = room)) } catch (error: Throwable) { failure.set(error) } }
                ui.start()
                try {
                    assertTrue(entered.await(5, TimeUnit.SECONDS)); companion.start()
                } finally { release.countDown(); ui.join(5000); if (companion.state != Thread.State.NEW) companion.join(5000) }
                assertFalse(ui.isAlive); assertFalse(companion.isAlive)
                assertEquals(MatrixClientError.SERVICE_UNAVAILABLE, (failure.get() as? MatrixClientException)?.reason)
                assertEquals(setOf(room), result.get()?.plaintextAllowedRooms); assertEquals(emptySet<String>(), result.get()?.authorityLostRooms)
                client.requirePlaintextAllowed(origin, room); assertEquals(listOf(null, null, null), cursors)
            }
        }
    }
    @Test fun matrixBackwardPageBoundsRequestAndDecodesOlderCallAnswer() {
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
            val stub = MatrixHttpStub { request ->
                val url = request.url.toHttpUrl()
                assertEquals("gap", url.queryParameter("from")); assertEquals("one", url.queryParameter("to"))
                assertEquals("b", url.queryParameter("dir")); assertEquals("50", url.queryParameter("limit"))
                MatrixHttpReply(200, """{"chunk":[{"type":"m.call.answer","event_id":"${'$'}answer","sender":"@member:example.org","origin_server_ts":100,"content":{"call_id":"$CALL","party_id":"other"}}],"end":"older"}""".toByteArray())
            }
            MatrixRoomClient(requester, LoopbackPolicy.REFUSE, httpStub = stub).use { client ->
                val page = client.fetchRoomMessagePage("https://atelier.matrix.kodera.io", "token", "!room:example.org", "gap", "one", 50)
                assertEquals("older", page.endToken); assertEquals(CALL, page.events.single().callId); assertEquals("other", page.events.single().callPartyId)
            }
        }
    }
    @Test fun answerOrRetirementDuringBootstrapBackfillCannotReconnectOrEndTheNextCall() {
        for (retired in listOf(false, true)) {
            val chat = ChatFixture(); val media = MediaFixture(); val presenter = PresenterFixture()
            chat.initialBatch = MatrixSyncBatch.fromDeltas("one", mapOf("!room:example.org" to MatrixRoomSyncDelta(emptyList(), limited = true, prevBatch = "gap")))
                .copy(plaintextAllowedRooms = setOf("!room:example.org"))
            val answer = MatrixRawTimelineEvent("m.call.answer", "\$old", chat.ownUserId, 100, callId = CALL, callPartyId = if (retired) "other" else "local")
            chat.pages = mapOf("gap" to MatrixTimelinePage(listOf(answer), null))
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            chat.beforeBackfill = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
            coordinator.bind(presenter)
            val failure = AtomicReference<Throwable?>()
            val receiving = Thread { try { coordinator.receive(wake()) } catch (error: Throwable) { failure.set(error) } }
            receiving.start()
            val nextId = "55555555-5555-4555-8555-555555555555"
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                if (retired) {
                    coordinator.end(CALL); chat.beforeBackfill = null
                    coordinator.receive(wake().copy(callId = nextId))
                } else coordinator.answer(CALL)
            } finally { release.countDown(); receiving.join(5000) }
            assertFalse(receiving.isAlive); assertNull(failure.get())
            assertEquals(if (retired) nextId else CALL, coordinator.currentCall()?.wake?.callId)
            assertEquals(if (retired) 0 else 1, media.connects.get()); assertEquals(if (retired) 1 else 0, media.disconnects.get())
            assertEquals(if (retired) listOf(NativeRingPhase.ENDED) else emptyList(), presenter.reasons)
            coordinator.end(if (retired) nextId else CALL)
        }
    }
    @Test fun limitedUIBatchRetainsItsExactGapForTheCompanion() {
        val chat = ChatFixture(); val media = MediaFixture(); val presenter = PresenterFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.bind(presenter); coordinator.receive(wake())
        val uiBatch = MatrixSyncBatch.fromDeltas("ui", mapOf("!room:example.org" to MatrixRoomSyncDelta(emptyList(), limited = true, prevBatch = "ui-gap")))
            .copy(plaintextAllowedRooms = setOf("!room:example.org"))
        val answer = MatrixRawTimelineEvent("m.call.answer", "\$older", chat.ownUserId, 100, callId = CALL, callPartyId = "other")
        chat.pages = mapOf("ui-gap" to MatrixTimelinePage(listOf(answer), "one"))
        coordinator.consumeAuthenticatedSync(uiBatch, "!room:example.org"); coordinator.pollCompanionTimeline()
        assertTrue(chat.syncRequests.isEmpty()); assertEquals(listOf("!room:example.org|ui-gap|one|50"), chat.pageRequests)
        assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get())
        assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
    }
    @Test fun pendingUIBackfillRetriesTransientFailureAndRevokesAuthorityFailure() {
        for (failure in listOf(MatrixClientError.SERVICE_UNAVAILABLE, MatrixClientError.FORBIDDEN)) {
            val chat = ChatFixture(); val media = MediaFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
            coordinator.receive(wake())
            val batch = MatrixSyncBatch.fromDeltas("ui", mapOf("!room:example.org" to MatrixRoomSyncDelta(emptyList(), limited = true, prevBatch = "gap")))
                .copy(plaintextAllowedRooms = setOf("!room:example.org"))
            coordinator.consumeAuthenticatedSync(batch, "!room:example.org")
            chat.pageFailure = failure; coordinator.pollCompanionTimeline()
            if (failure == MatrixClientError.FORBIDDEN) { assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get()) }
            else {
                assertNotNull(coordinator.currentCall()); assertEquals(0, media.disconnects.get())
                chat.pageFailure = null; coordinator.pollCompanionTimeline()
                assertEquals(listOf("!room:example.org|gap|one|50", "!room:example.org|gap|one|50"), chat.pageRequests)
                assertEquals(listOf<String?>(null), chat.syncRequests); coordinator.end(CALL)
            }
        }
    }
    @Test fun forwardedUIFailureCannotBeOverwrittenByAnInFlightCompanionPoll() {
        val chat = ChatFixture(); val media = MediaFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.receive(wake())
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        chat.beforeSync = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        val polling = Thread { coordinator.pollCompanionTimeline() }
        polling.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            coordinator.consumeTransportFailure(MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE))
        } finally { release.countDown(); polling.join(5000) }
        assertFalse(polling.isAlive); chat.beforeSync = null
        coordinator.pollCompanionTimeline()
        assertEquals(listOf("one", null), chat.syncRequests)
        assertNotNull(coordinator.currentCall()); assertEquals(0, media.disconnects.get())
        coordinator.end(CALL)
    }
    @Test fun limitedTimelineRecoversOlderAnswersAndBoundsPagination() {
        for (mode in listOf("answer", "emptyPage", "cursor", "cycle", "budget", "noEnd")) {
            val chat = ChatFixture(); val media = MediaFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
            coordinator.bind(presenter); coordinator.receive(wake()); coordinator.answer(CALL)
            val message = MatrixRawTimelineEvent("m.room.message", "\$message", "@peer:example.org", 100)
            val answer = MatrixRawTimelineEvent("m.call.answer", "\$answer", chat.ownUserId, 100, callId = CALL, callPartyId = "other")
            chat.events = List(25) { message }; chat.limitedRooms = setOf("!room:example.org"); chat.prevBatch = "gap"
            chat.pages = mapOf(
                "gap" to MatrixTimelinePage(if (mode == "emptyPage" || mode == "noEnd") emptyList() else List(50) { message }, if (mode == "noEnd") null else if (mode == "cursor") "one" else "older"),
                "older" to MatrixTimelinePage(listOf(if (mode == "answer" || mode == "emptyPage") answer else message), if (mode == "cycle") "gap" else "third"),
                "third" to MatrixTimelinePage(listOf(message), "fourth"),
                "fourth" to MatrixTimelinePage(listOf(message), "fifth"),
                "fifth" to MatrixTimelinePage(listOf(answer), null),
            )
            coordinator.pollCompanionTimeline()
            val count = when (mode) { "noEnd", "cursor" -> 1; "answer", "emptyPage", "cycle" -> 2; else -> 4 }
            assertEquals(count, chat.pageRequests.size); assertEquals("!room:example.org|gap|one|50", chat.pageRequests.first())
            if (mode == "answer" || mode == "emptyPage") {
                assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get())
                assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
            } else {
                assertNotNull(coordinator.currentCall()); assertEquals(0, media.disconnects.get()); coordinator.end(CALL)
            }
        }
    }
    @Test fun realMatrixClientRecoversCompanionPollAfter503WithoutFalseAuthorityLoss() {
        for ((connected, viaUI) in listOf(false to false, false to true, true to false, true to true)) {
            CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
                val snapshot = WorkspaceSnapshot(ORG, WorkspaceState.INITIALISED,
                    WorkspaceSetup(WorkspaceSetupState.READY, null), false,
                    "00000000-0000-4000-8000-000000000020", emptyList(), listOf(
                        WorkspaceChannel(CHANNEL, ChannelKind.AUDIO, "call", null, "",
                            WorkspaceChannelLifecycle.ACTIVE, ChannelRoomState.READY, false)))
                val cursors = mutableListOf<String?>()
                fun sync(cursor: String, events: String = "[]") = MatrixHttpReply(200,
                    """{"next_batch":"$cursor","rooms":{"join":{"!room:example.org":{"state":{"events":[]},"timeline":{"events":$events}}}}}""".toByteArray())
                val stub = MatrixHttpStub { request ->
                    val url = request.url.toHttpUrl()
                    when {
                        url.encodedPath == "/.well-known/matrix/client" -> MatrixHttpReply(404)
                        url.encodedPath.startsWith("/_matrix/client/v3/directory/room/") || url.encodedPath.endsWith("/join") ->
                            MatrixHttpReply(200, """{"room_id":"!room:example.org"}""".toByteArray())
                        url.encodedPath == "/_matrix/client/v3/sync" -> {
                            cursors += url.queryParameter("since")
                            when (cursors.size) {
                                1 -> sync("one")
                                2 -> MatrixHttpReply(503)
                                3 -> sync("recovered")
                                4 -> sync("answered", """[{"type":"m.call.answer","event_id":"${'$'}answer","sender":"@member:example.org","origin_server_ts":100,"content":{"call_id":"$CALL","party_id":"other"}}]""")
                                else -> error("Unexpected extra sync")
                            }
                        }
                        else -> error("Unexpected Matrix request: ${url.encodedPath}")
                    }
                }
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, httpStub = stub).use { client ->
                    MatrixChannelConversationTransport(ownUserId = "@member:example.org", roomClient = client,
                        organisationSlug = "atelier", matrixDomain = "matrix.kodera.io",
                        matrixServerName = "atelier.matrix.kodera.io", matrixAccessToken = "token",
                        fetchWorkspace = { WorkspaceOutcome.Loaded(snapshot) }).use { transport ->
                        val media = MediaFixture(); val presenter = PresenterFixture()
                        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, transport, { 100 })
                        coordinator.bind(presenter); coordinator.receive(wake())
                        if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
                        val owner = coordinator.ownership(CALL)
                        assertEquals(CALL, coordinator.currentCall()?.wake?.callId)
                        if (viaUI) {
                            val failure = assertThrows(MatrixClientException::class.java) { transport.syncRoom("!room:example.org", "ui") }
                            coordinator.consumeTransportFailure(failure)
                        } else coordinator.pollCompanionTimeline()
                        assertEquals(CALL, coordinator.currentCall()?.wake?.callId); assertEquals(0, media.disconnects.get())
                        assertEquals(connected, media.microphone); assertTrue(presenter.reasons.isEmpty())
                        coordinator.pollCompanionTimeline() // Full 200 sync must restore matrixKnown.
                        assertEquals(CALL, coordinator.currentCall()?.wake?.callId); assertEquals(owner, coordinator.ownership(CALL))
                        assertEquals(if (connected) NativeRingPhase.CONNECTED else NativeRingPhase.RINGING, coordinator.phase(CALL))
                        assertEquals(0, media.disconnects.get()); assertEquals(connected, media.microphone)
                        assertTrue(presenter.reasons.isEmpty())
                        coordinator.pollCompanionTimeline()
                        assertEquals(listOf(null, if (viaUI) "ui" else "one", null, "recovered"), cursors)
                        assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get()); assertFalse(media.microphone)
                        assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
                    }
                }
            }
        }
    }
    @Test fun companionPollResetsCursorAfterTransientFailuresWithoutRetiringCall() {
        for (connected in listOf(false, true)) {
            for (failure in listOf(MatrixClientError.SERVICE_UNAVAILABLE, MatrixClientError.TRANSPORT, MatrixClientError.RATE_LIMITED)) {
                val media = MediaFixture(); val chat = ChatFixture(); val presenter = PresenterFixture()
                val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
                coordinator.bind(presenter); coordinator.receive(wake())
                if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
                val owner = coordinator.ownership(CALL)
                chat.syncFailure = failure
                coordinator.pollCompanionTimeline(); coordinator.pollCompanionTimeline()
                assertEquals(CALL, coordinator.currentCall()?.wake?.callId); assertEquals(owner, coordinator.ownership(CALL))
                assertEquals(if (connected) NativeRingPhase.CONNECTED else NativeRingPhase.RINGING, coordinator.phase(CALL))
                assertEquals(0, media.disconnects.get()); assertEquals(connected, media.microphone); assertTrue(presenter.reasons.isEmpty())
                chat.syncFailure = null; coordinator.pollCompanionTimeline()
                chat.events = listOf(MatrixRawTimelineEvent("m.call.answer", "\$answer", chat.ownUserId, 100, callId = CALL, callPartyId = "other"))
                coordinator.pollCompanionTimeline()
                assertEquals(listOf("one", null, null, "two"), chat.syncRequests)
                assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get())
                assertEquals(listOf(NativeRingPhase.ANSWERED_ELSEWHERE), presenter.reasons)
            }
        }
    }
    @Test fun companionPollAuthorityFailuresImmediatelyRetireRingingAndConnectedCalls() {
        for (connected in listOf(false, true)) {
            for (failure in listOf(MatrixClientError.UNAUTHORIZED, MatrixClientError.FORBIDDEN, MatrixClientError.NOT_FOUND,
                MatrixClientError.PLAINTEXT_FORBIDDEN, MatrixClientError.PROTOCOL_VIOLATION, MatrixClientError.SIGNED_OUT, MatrixClientError.IDENTITY_UNAVAILABLE)) {
                val media = MediaFixture(); val chat = ChatFixture(); val presenter = PresenterFixture()
                val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
                coordinator.bind(presenter); coordinator.receive(wake())
                if (connected) { coordinator.answer(CALL); coordinator.audioSession(true) }
                chat.syncFailure = failure; coordinator.pollCompanionTimeline(); coordinator.pollCompanionTimeline()
                assertNull(coordinator.currentCall()); assertNull(coordinator.phase(CALL))
                assertEquals(1, media.disconnects.get()); assertFalse(media.microphone)
                assertEquals(listOf(NativeRingPhase.REVOKED), presenter.reasons); assertEquals(listOf("one"), chat.syncRequests)
            }
        }
    }
    @Test fun limitedCallTimelineResetsCursorAndRecoversOmittedAnswerOrAuthority() {
        for (recovery in listOf("answer", "authority", "continue")) {
            val media = MediaFixture(); val chat = ChatFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
            coordinator.bind(presenter); coordinator.receive(wake()); coordinator.answer(CALL)
            chat.limitedRooms = setOf("!other:example.org"); coordinator.pollCompanionTimeline()
            chat.limitedRooms = setOf("!room:example.org"); coordinator.pollCompanionTimeline()
            assertNotNull(coordinator.currentCall()); assertEquals(0, media.disconnects.get())
            // Recovery can also fail transiently; the reset cursor must survive that failure.
            chat.syncFailure = MatrixClientError.SERVICE_UNAVAILABLE; coordinator.pollCompanionTimeline(); chat.syncFailure = null
            val events = if (recovery == "answer") listOf(MatrixRawTimelineEvent("m.call.answer", "\$omitted", chat.ownUserId, 100,
                callId = CALL, callPartyId = "other")) else emptyList()
            chat.recoveryBatch = MatrixSyncBatch("recovered", mapOf("!room:example.org" to events),
                plaintextAllowedRooms = setOf("!room:example.org"),
                authorityLostRooms = if (recovery == "authority") setOf("!room:example.org") else emptySet())
            coordinator.pollCompanionTimeline()
            assertEquals(listOf("one", "two", null, null), chat.syncRequests)
            if (recovery == "continue") {
                assertNotNull(coordinator.currentCall()); assertTrue(presenter.reasons.isEmpty())
                chat.limitedRooms = emptySet(); coordinator.pollCompanionTimeline(); assertEquals("recovered", chat.syncRequests.last())
                coordinator.end(CALL)
            } else {
                assertNull(coordinator.currentCall()); assertEquals(1, media.disconnects.get())
                assertEquals(listOf(if (recovery == "answer") NativeRingPhase.ANSWERED_ELSEWHERE else NativeRingPhase.REVOKED), presenter.reasons)
            }
        }
    }
    @Test fun replacingExpiredRingEndsPreviousCallBeforePresentingNextCall() {
        for (timestamp in listOf(130L, 160L)) {
            var time = 100L
            val media = MediaFixture(); val presenter = PresenterFixture()
            val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, ChatFixture(), { time })
            coordinator.bind(presenter); coordinator.receive(wake())
            val oldOwner = coordinator.ownership(CALL)!!
            val nextId = "55555555-5555-4555-8555-555555555555"
            presenter.onEnded = {
                assertNull(coordinator.currentCall()); assertNull(coordinator.ownership(CALL)); assertNull(coordinator.ownership(nextId))
                assertEquals(1, presenter.metadata)
            }
            time = timestamp; coordinator.receive(wake().copy(callId = nextId, expiresAt = timestamp + 30))
            presenter.onEnded = null
            assertEquals(listOf("ring:$CALL", "end:$CALL:EXPIRED", "ring:$nextId"), presenter.lifecycle)
            assertEquals(1, media.disconnects.get()); assertEquals(nextId, coordinator.currentCall()?.wake?.callId)
            coordinator.end(CALL); coordinator.answer(CALL, expectedOwner = oldOwner, activateAudio = true); coordinator.tick()
            assertEquals(listOf(NativeRingPhase.EXPIRED), presenter.reasons); assertEquals(NativeRingPhase.RINGING, coordinator.phase(nextId))
            assertFalse(media.microphone); coordinator.answer(nextId); assertEquals(NativeRingPhase.CONNECTED, coordinator.phase(nextId))
            coordinator.end(nextId); assertEquals(listOf(NativeRingPhase.EXPIRED, NativeRingPhase.ENDED), presenter.reasons)
        }
    }
    @Test fun companionPollCoalescesAndLateFailureCannotRetireTheNextCall() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val media = MediaFixture(); val chat = ChatFixture()
        val coordinator = NativeCallCoordinator(ORG, "local", resolver(), media, chat, { 100 })
        coordinator.receive(wake())
        chat.beforeSync = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        val polling = Thread { coordinator.pollCompanionTimeline() }
        polling.start()
        val nextId = "55555555-5555-4555-8555-555555555555"
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            coordinator.pollCompanionTimeline(); assertEquals(listOf("one"), chat.syncRequests)
            coordinator.end(CALL); coordinator.receive(wake().copy(callId = nextId))
            chat.syncFailure = MatrixClientError.FORBIDDEN
        } finally { release.countDown(); polling.join(5000) }
        assertFalse(polling.isAlive); assertEquals(nextId, coordinator.currentCall()?.wake?.callId)
        assertEquals(1, media.disconnects.get())
        chat.beforeSync = null; chat.syncFailure = null
        coordinator.pollCompanionTimeline()
        assertEquals(listOf("one", "one"), chat.syncRequests)
        coordinator.end(nextId)
    }
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

package io.kodera.android.client

import io.kodera.android.domain.KoderaMobileFfiFailure
import io.kodera.android.domain.NativeCallRing
import io.kodera.android.domain.NativeCallWake
import io.kodera.android.domain.NativeRingPhase
import java.util.UUID

/** Metadata is obtained only over authenticated Core/Matrix transport. */
data class AuthenticatedNativeCall(val wake: NativeCallWake, val roomId: String, val callerLabel: String) {
    init {
        require(listOf(roomId, callerLabel).all { it.isNotEmpty() && it.toByteArray().size <= 255 && it.none(Char::isISOControl) })
    }
}
fun interface NativeCallResolver {
    /** Revalidates membership and confidential authority. A 404 must throw. */
    fun resolve(wake: NativeCallWake): AuthenticatedNativeCall
}
interface LiveKitWebRTCSession {
    /** Connect with capture disabled; fetch scoped credentials through authenticated transport. */
    fun connect(call: AuthenticatedNativeCall)
    fun microphone(enabled: Boolean)
    fun audioSession(active: Boolean)
    fun networkPathChanged()
    /** Cancel owned SDK operations so late callbacks cannot publish microphone audio. */
    fun disconnect()
}
interface NativeCallPresenter {
    fun ringing(call: AuthenticatedNativeCall)
    fun connected(callId: String)
    fun ended(callId: String, reason: NativeRingPhase)
}

/** Network calls execute outside the state lock so ring cancellation never waits for them. */
class NativeCallCoordinator(
    organisationId: String,
    private val localPartyId: String,
    private val resolver: NativeCallResolver,
    private val media: LiveKitWebRTCSession,
    val conversation: ChannelConversationTransport,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    init { require(localPartyId.isNotEmpty() && localPartyId.toByteArray().size <= 128) }
    private val lock = Any()
    // A retired connect must finish closing before a subsequent connect can open.
    private val mediaLock = Any()
    private val ring = NativeCallRing(organisationId)
    private var generation = 0L
    private var activeId: String? = null
    private var call: AuthenticatedNativeCall? = null
    private var answerRequested = false
    private var audioActive = false
    private var muted = false
    private var stopped = false
    private var presenter: NativeCallPresenter? = null
    fun bind(presenter: NativeCallPresenter) = synchronized(lock) { this.presenter = presenter }
    fun phase(callId: String): NativeRingPhase? = synchronized(lock) { ring.records[callId]?.phase }
    fun currentCall(): AuthenticatedNativeCall? = synchronized(lock) { call }
    fun ownership(callId: String): Long? = synchronized(lock) { if (!stopped && activeId == callId) generation else null }
    fun ownsCall(callId: String, owner: Long): Boolean = owns(owner, callId)
    fun receive(wake: NativeCallWake) {
        val owner = synchronized(lock) {
            check(!stopped)
            // Admission errors describe an untrusted wake, never loss of the active call's authority.
            try { ring.observe(wake, now()) } catch (_: KoderaMobileFfiFailure) { return }
            if (wake.state != NativeRingPhase.RINGING) {
                if (activeId == wake.callId) finish(wake.state)
                return
            }
            generation += 1; activeId = wake.callId; answerRequested = false; generation
        }
        try {
            val resolved = resolver.resolve(wake)
            if (!owns(owner, wake.callId)) return
            check(resolved.wake == wake); wake.validate(now())
            val room = conversation.bootstrapRoom(wake.organisationId, wake.channelId)
            synchronized(lock) {
                if (!owns(owner, wake.callId)) return
                check(room.roomId == resolved.roomId); wake.validate(now())
                call = resolved; consumeAuthenticatedSync(room.initialBatch)
                if (!owns(owner, wake.callId)) return
                presenter?.ringing(resolved)
            }
            if (synchronized(lock) { answerRequested && owns(owner, wake.callId) }) connect(owner, resolved)
        } catch (failure: Exception) {
            synchronized(lock) { if (owns(owner, wake.callId)) finish(NativeRingPhase.REVOKED) }
            throw failure
        }
    }
    fun answer(callId: String, expectedOwner: Long? = null, activateAudio: Boolean = false) {
        val context = synchronized(lock) {
            if (expectedOwner != null && !owns(expectedOwner, callId)) return
            check(!stopped && activeId == callId && ring.records[callId]?.phase == NativeRingPhase.RINGING && !answerRequested)
            if (activateAudio) audioSession(true)
            if (expectedOwner != null && !owns(expectedOwner, callId)) return
            answerRequested = true; call?.let { generation to it }
        }
        context?.let { connect(it.first, it.second) }
    }
    private fun connect(owner: Long, call: AuthenticatedNativeCall): Unit = synchronized(mediaLock) {
        try {
            synchronized(lock) {
                if (!owns(owner, call.wake.callId)) return
                call.wake.validate(now()); ring.transition(call.wake.callId, NativeRingPhase.CONNECTING)
            }
            media.connect(call)
            synchronized(lock) {
                if (!owns(owner, call.wake.callId)) { media.disconnect(); return }
                ring.transition(call.wake.callId, NativeRingPhase.CONNECTED)
                media.microphone(audioActive && !muted); presenter?.connected(call.wake.callId)
            }
        } catch (failure: Exception) {
            synchronized(lock) {
                if (owns(owner, call.wake.callId)) finish(NativeRingPhase.REVOKED) else media.disconnect()
            }; throw failure
        }
    }
    fun setMuted(value: Boolean) = synchronized(lock) {
        muted = value
        if (activeId?.let { ring.records[it]?.phase } == NativeRingPhase.CONNECTED) {
            try { media.microphone(audioActive && !muted) } catch (failure: Exception) { finish(NativeRingPhase.REVOKED); throw failure }
        }
    }
    fun audioSession(active: Boolean) = synchronized(lock) {
        if (stopped) return@synchronized
        audioActive = active; media.audioSession(active); setMuted(muted)
    }
    fun networkPathChanged() {
        val context = synchronized(lock) {
            val id = activeId ?: return
            if (ring.records[id]?.phase != NativeRingPhase.CONNECTED) return
            generation to id
        }
        try { media.networkPathChanged() } catch (_: Exception) {
            synchronized(lock) { if (owns(context.first, context.second)) finish(NativeRingPhase.REVOKED) }
        }
    }
    fun sendCompanionMessage(body: String): String {
        val context = synchronized(lock) {
            val current = call ?: error("call unavailable")
            check(ring.records[current.wake.callId]?.phase == NativeRingPhase.CONNECTED)
            generation to current
        }
        try {
            val result = conversation.sendMessage(context.second.roomId, UUID.randomUUID().toString(), body, null, emptyList())
            check(owns(context.first, context.second.wake.callId)); return result
        } catch (failure: Exception) {
            synchronized(lock) { if (owns(context.first, context.second.wake.callId)) finish(NativeRingPhase.REVOKED) }; throw failure
        }
    }
    fun syncCompanionTimeline(since: String?): MatrixSyncBatch {
        val context = synchronized(lock) { generation to (call ?: error("call unavailable")) }
        try {
            val batch = conversation.syncRoom(context.second.roomId, since)
            synchronized(lock) {
                check(owns(context.first, context.second.wake.callId)); consumeAuthenticatedSync(batch)
            }
            return batch
        } catch (failure: Exception) {
            synchronized(lock) { if (owns(context.first, context.second.wake.callId)) finish(NativeRingPhase.REVOKED) }; throw failure
        }
    }
    fun consumeAuthenticatedSync(batch: MatrixSyncBatch) = synchronized(lock) {
        val current = call ?: return@synchronized
        if (current.roomId in batch.authorityLostRooms) { finish(NativeRingPhase.REVOKED); return@synchronized }
        if (batch.roomEvents[current.roomId].orEmpty().any {
            it.type == "m.call.answer" && it.sender == conversation.ownUserId && !it.isRedactedUnsigned &&
                it.callId == current.wake.callId && !it.callPartyId.isNullOrEmpty() && it.callPartyId != localPartyId
        }) finish(NativeRingPhase.ANSWERED_ELSEWHERE)
    }
    /** Only scope-correlated authenticated Matrix answer/call-membership events enter here. */
    fun answeredElsewhere(callId: String, organisationId: String, channelId: String) = synchronized(lock) {
        val record = ring.records[callId]
        if (activeId == callId && record?.wake?.organisationId == organisationId && record.wake.channelId == channelId) finish(NativeRingPhase.ANSWERED_ELSEWHERE)
    }
    fun end(callId: String, declined: Boolean = false) = synchronized(lock) {
        if (activeId == callId) finish(if (declined) NativeRingPhase.DECLINED else NativeRingPhase.ENDED)
    }
    fun tick() = synchronized(lock) {
        val id = activeId; ring.tick(now())
        if (id != null && (ring.records[id] == null || ring.records[id]?.phase == NativeRingPhase.EXPIRED)) finish(NativeRingPhase.EXPIRED)
    }
    fun revoke() = synchronized(lock) { stopped = true; finish(NativeRingPhase.REVOKED); ring.revoke() }
    private fun owns(owner: Long, id: String) = synchronized(lock) { !stopped && generation == owner && activeId == id }
    private fun finish(reason: NativeRingPhase) {
        generation += 1; val id = activeId; activeId = null; call = null; answerRequested = false; muted = false; audioActive = false
        media.disconnect()
        if (reason == NativeRingPhase.REVOKED) { stopped = true; ring.revoke() }
        if (id != null) {
            runCatching { ring.transition(id, reason) }; presenter?.ended(id, reason)
        }
    }
}

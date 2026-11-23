package io.kodera.android.domain

/** Wire values shared with kodera_rs::mobile_calls. */
enum class NativeRingPhase(val wire: String) {
    RINGING("ringing"), CONNECTING("connecting"), CONNECTED("connected"), ANSWERED_ELSEWHERE("answered_elsewhere"),
    DECLINED("declined"), ENDED("ended"), EXPIRED("expired"), REVOKED("revoked");
    val terminal: Boolean get() = this !in setOf(RINGING, CONNECTING, CONNECTED)
}

data class NativeCallWake(val callId: String, val organisationId: String, val channelId: String,
    val epoch: Long, val state: NativeRingPhase, val expiresAt: Long) {
    init {
        if (!listOf(callId, organisationId, channelId).all(TrustPolicy::canonicalNonNilUUID) || epoch !in 1..9_007_199_254_740_991L ||
            state !in setOf(NativeRingPhase.RINGING, NativeRingPhase.ANSWERED_ELSEWHERE, NativeRingPhase.ENDED)) fail(KoderaMobileFfiError.INVALID_INPUT)
    }
    fun validate(now: Long) {
        if (now !in 1..9_007_199_254_740_931L) fail(KoderaMobileFfiError.INVALID_INPUT)
        if (expiresAt <= now || expiresAt - now > 60) fail(KoderaMobileFfiError.STALE_EPOCH)
    }
    companion object {
        fun admit(data: ByteArray, now: Long, dispatcher: PacketDispatcher = KoderaMobileFfiBridge()): NativeCallWake {
            if (data.size > 4096) fail(KoderaMobileFfiError.CAPACITY_EXCEEDED)
            val hex = data.joinToString("") { "%02x".format(it.toInt() and 255) }
            val request = """{"op":"call_wake_admit","payload_hex":"$hex","now":$now}"""
            val response = dispatcher.dispatch(KoderaFfiPacket(request.toByteArray()))
            if (response.status != 0) fail(KoderaMobileFfiError.INVALID_INPUT)
            return decodeNativeCallWake(response.payloadBytes(), now, response = true)
        }
        internal fun fail(reason: KoderaMobileFfiError): Nothing = throw KoderaMobileFfiFailure(reason)
    }
}
data class NativeRingRecord(val wake: NativeCallWake, val phase: NativeRingPhase, val missed: Boolean, internal val retainUntil: Long)

/** Session-owned reducer matching the shared core; never evicts live cancellation tombstones. */
class NativeCallRing(val organisationId: String) {
    private val entries = mutableMapOf<String, NativeRingRecord>()
    val records: Map<String, NativeRingRecord> get() = entries.toMap()
    private var clock = 0L
    init { require(TrustPolicy.canonicalNonNilUUID(organisationId)) }
    fun observe(wake: NativeCallWake, now: Long) {
        wake.validate(now)
        if (now < clock) NativeCallWake.fail(KoderaMobileFfiError.STALE_EPOCH)
        if (wake.organisationId != organisationId) NativeCallWake.fail(KoderaMobileFfiError.ORGANISATION_MISMATCH)
        tick(now)
        val old = entries[wake.callId]
        if (old != null) {
            if (old.wake.channelId != wake.channelId) NativeCallWake.fail(KoderaMobileFfiError.ORGANISATION_MISMATCH)
            if ((old.phase.terminal && !(old.phase == NativeRingPhase.EXPIRED && wake.state == NativeRingPhase.ANSWERED_ELSEWHERE)) || wake.epoch <= old.wake.epoch || wake.state == NativeRingPhase.RINGING) NativeCallWake.fail(KoderaMobileFfiError.REPLAY_DETECTED)
        } else if (entries.size >= 128 || wake.state == NativeRingPhase.RINGING && entries.values.any { !it.phase.terminal }) {
            NativeCallWake.fail(KoderaMobileFfiError.CAPACITY_EXCEEDED)
        }
        entries[wake.callId] = NativeRingRecord(wake, wake.state, false, now + 60)
    }
    fun transition(callId: String, next: NativeRingPhase) {
        val r = entries[callId] ?: NativeCallWake.fail(KoderaMobileFfiError.INVALID_INPUT)
        val valid = r.phase == NativeRingPhase.RINGING && next == NativeRingPhase.CONNECTING ||
            r.phase == NativeRingPhase.CONNECTING && next == NativeRingPhase.CONNECTED ||
            next in setOf(NativeRingPhase.ANSWERED_ELSEWHERE, NativeRingPhase.DECLINED, NativeRingPhase.ENDED, NativeRingPhase.REVOKED)
        if (r.phase.terminal || !valid) NativeCallWake.fail(KoderaMobileFfiError.REPLAY_DETECTED)
        entries[callId] = r.copy(phase = next, missed = false)
    }
    fun tick(now: Long) {
        clock = maxOf(clock, now)
        entries.replaceAll { _, r ->
            if (r.phase in setOf(NativeRingPhase.RINGING, NativeRingPhase.CONNECTING) && r.wake.expiresAt <= clock)
                r.copy(phase = NativeRingPhase.EXPIRED, missed = r.phase == NativeRingPhase.RINGING) else r
        }
        entries.entries.removeIf { it.value.phase.terminal && it.value.retainUntil <= clock }
    }
    fun revoke() { entries.clear() }
}

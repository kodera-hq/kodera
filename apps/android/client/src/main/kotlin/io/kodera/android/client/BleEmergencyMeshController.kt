package io.kodera.android.client

import io.kodera.android.domain.*

/** Organisation-scoped, in-memory protocol controller. A radio adapter must own delivery separately. */
class BleEmergencyMeshController(
    val organisationId: String, salt: ByteArray, allowedRoster: Set<EmergencyPublicKey>,
    private val verifier: EmergencySignatureVerifier = Ed25519EmergencyVerifier,
    private val capacity: Int = 128, replayCapacity: Int = 1024,
) {
    init { require(salt.size == 32 && allowedRoster.isNotEmpty() && allowedRoster.size <= EmergencyBounds.ROSTER_MEMBERS) }
    private val salt = salt.copyOf()
    private val allowed = allowedRoster.toSet()
    private val replay = EmergencyReplayGuard(replayCapacity)
    private val queue = mutableListOf<EmergencyFrame>()
    private val roster = mutableMapOf<EmergencyPublicKey, EmergencyMemberStatus>()
    init { require(capacity in 1..EmergencyBounds.QUEUE_CAPACITY && TrustPolicy.canonicalNonNilUUID(organisationId)) }

    @JvmOverloads
    @Synchronized fun currentBeacon(unixSeconds: Long = EmergencyBounds.currentUnixSeconds()) =
        ProximityBeacon.compute(salt, unixSeconds)
    @Synchronized fun createLocalCheckIn(id: EmergencyMessageId, status: EmergencySafetyStatus, text: String,
        signer: EmergencySigner, ttlHops: Int = 6): ByteArray {
        val frame = EmergencyFrame.signed(id, ttlHops, status, text, signer)
        val verified = frame.verify(allowed, verifier)
        if (queue.any { it.messageId == id } || replay.contains(id)) throw EmergencyFailure(EmergencyError.REPLAY)
        if (roster[frame.senderPublicKey]?.let { id <= it.messageId } == true)
            throw EmergencyFailure(EmergencyError.OUT_OF_ORDER)
        if (!admit(frame)) throw EmergencyFailure(EmergencyError.QUEUE_FULL)
        replay.acceptOnce(verified)
        updateRoster(frame)
        return frame.encode()
    }

    @Synchronized fun ingestPeerFrame(observedBeacon: ByteArray, bytes: ByteArray): EmergencyFrame? =
        ingestPeerFrame(observedBeacon, EmergencyBounds.currentUnixSeconds(), bytes)

    @Synchronized fun ingestPeerFrame(observedBeacon: ByteArray, unixSeconds: Long, bytes: ByteArray): EmergencyFrame? {
        if (!ProximityBeacon.matches(salt, observedBeacon, unixSeconds)) throw EmergencyFailure(EmergencyError.INVALID_BEACON)
        val frame = EmergencyFrame.decode(bytes)
        // A frame dated far ahead would outrank every real check-in from its sender until the clock caught up.
        val nowMillis = if (unixSeconds > Long.MAX_VALUE / 1000) Long.MAX_VALUE else unixSeconds * 1000
        if (EmergencyBounds.isTooFarAhead(frame.messageId.timestampMillis, nowMillis)) throw EmergencyFailure(EmergencyError.FUTURE_FRAME)
        val verified = frame.verify(allowed, verifier)
        // An authenticated historical status must not displace current safety information
        // or consume replay memory merely because it has a higher relay priority.
        if (roster[frame.senderPublicKey]?.let { frame.messageId <= it.messageId } == true) return null
        if (queue.any { it.messageId == frame.messageId } || !replay.acceptOnce(verified)) return null
        updateRoster(frame)
        frame.decrementHop()?.let { admit(it) }
        return frame
    }

    @Synchronized fun drainRelayBatch(maxFrames: Int): List<ByteArray> {
        require(maxFrames in 0..capacity)
        val selected = queue.sortedWith(compareByDescending<EmergencyFrame> { it.status.priority }.thenByDescending { it.messageId }).take(maxFrames)
        queue.removeAll(selected.toSet())
        return selected.map { it.encode() }
    }
    @Synchronized fun memberStatuses(): List<EmergencyMemberStatus> = roster.values.sortedBy { it.publicKey.toString() }
    @Synchronized fun queuedFrameCount(): Int = queue.size
    /** Local and peer traffic share the same priority/capacity policy. Rejection changes nothing. */
    private fun admit(frame: EmergencyFrame): Boolean {
        if (queue.any { it.messageId == frame.messageId }) return false
        if (queue.size == capacity) {
            val worst = queue.minWithOrNull(compareBy<EmergencyFrame> { it.status.priority }.thenBy { it.messageId })!!
            if (compareValuesBy(frame, worst, { it.status.priority }, { it.messageId }) <= 0) return false
            queue.remove(worst)
        }
        queue.add(frame)
        return true
    }
    private fun updateRoster(frame: EmergencyFrame) {
        val previous = roster[frame.senderPublicKey]
        if (previous == null || frame.messageId > previous.messageId) {
            roster[frame.senderPublicKey] = EmergencyMemberStatus(frame.senderPublicKey, frame.status, frame.text,
                frame.messageId.timestampMillis, frame.ttlHops, frame.messageId)
        }
    }
}

data class EmergencyMemberStatus(val publicKey: EmergencyPublicKey, val status: EmergencySafetyStatus,
    val text: String, val timestampMillis: Long, val remainingTtlHops: Int, val messageId: EmergencyMessageId)

/** UI submission reports only local queue admission, never remote receipt or assistance dispatch. */
class EmergencyCheckInSession(private val controller: BleEmergencyMeshController,
    private val signer: EmergencySigner, private val nextId: () -> EmergencyMessageId) {
    val organisationId: String get() = controller.organisationId
    @Synchronized fun checkIn(status: EmergencySafetyStatus): EmergencyMemberStatus {
        val frame = EmergencyFrame.decode(controller.createLocalCheckIn(nextId(), status, "", signer))
        return EmergencyMemberStatus(frame.senderPublicKey, frame.status, frame.text,
            frame.messageId.timestampMillis, frame.ttlHops, frame.messageId)
    }
}

/** A single displayed card's lease, not radio membership or a replacement for provisioning. */
class EmergencyCheckInLease(private val session: EmergencyCheckInSession) : AutoCloseable {
    private var closed = false
    val organisationId: String get() = session.organisationId

    /** Check the latest display owner before consuming a message ID or mutating the queue. */
    @Synchronized fun checkIn(currentOrganisationId: String?, status: EmergencySafetyStatus): EmergencyMemberStatus {
        if (closed || currentOrganisationId != organisationId ||
            !TrustPolicy.canonicalNonNilUUID(organisationId)) throw EmergencyFailure(EmergencyError.UNAUTHORIZED)
        return session.checkIn(status)
    }

    @Synchronized override fun close() { closed = true }
}

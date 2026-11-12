package io.kodera.android.client

import io.kodera.android.domain.*

/** Organisation-scoped, in-memory protocol controller. A radio adapter must own delivery separately. */
class BleProximityMeshController(
    val organisationId: String, salt: ByteArray, allowedRoster: Set<ProximityPublicKey>,
    private val verifier: ProximitySignatureVerifier = Ed25519ProximityVerifier,
    private val capacity: Int = 128, replayCapacity: Int = 1024,
) {
    init { require(salt.size == 32 && allowedRoster.isNotEmpty() && allowedRoster.size <= ProximityBounds.ROSTER_MEMBERS) }
    private val salt = salt.copyOf()
    private val allowed = allowedRoster.toSet()
    private val replay = ProximityReplayGuard(replayCapacity)
    private val queue = mutableListOf<ProximityFrame>()
    private val roster = mutableMapOf<ProximityPublicKey, ProximityMemberStatus>()
    /** Pseudonyms members picked, by provisioned key. Display metadata only: never consulted to admit anything. */
    private val dedicatedHandles = mutableMapOf<ProximityPublicKey, ProximityHandle>()
    init { require(capacity in 1..ProximityBounds.QUEUE_CAPACITY && TrustPolicy.canonicalNonNilUUID(organisationId)) }

    @JvmOverloads
    @Synchronized fun currentBeacon(unixSeconds: Long = ProximityBounds.currentUnixSeconds()) =
        ProximityBeacon.compute(salt, unixSeconds)
    @Synchronized fun createLocalCheckIn(id: ProximityMessageId, status: ProximitySafetyStatus, text: String,
        signer: ProximitySigner, ttlHops: Int = 6): ByteArray {
        val frame = ProximityFrame.signed(id, ttlHops, status, text, signer)
        val verified = frame.verify(allowed, verifier)
        if (queue.any { it.messageId == id } || replay.contains(id)) throw ProximityFailure(ProximityError.REPLAY)
        if (roster[frame.senderPublicKey]?.let { id <= it.messageId } == true)
            throw ProximityFailure(ProximityError.OUT_OF_ORDER)
        if (!admit(frame)) throw ProximityFailure(ProximityError.QUEUE_FULL)
        replay.acceptOnce(verified)
        updateRoster(frame)
        return frame.encode()
    }

    @Synchronized fun ingestPeerFrame(observedBeacon: ByteArray, bytes: ByteArray): ProximityFrame? =
        ingestPeerFrame(observedBeacon, ProximityBounds.currentUnixSeconds(), bytes)

    @Synchronized fun ingestPeerFrame(observedBeacon: ByteArray, unixSeconds: Long, bytes: ByteArray): ProximityFrame? {
        if (!ProximityBeacon.matches(salt, observedBeacon, unixSeconds)) throw ProximityFailure(ProximityError.INVALID_BEACON)
        val frame = ProximityFrame.decode(bytes)
        // A frame dated far ahead would outrank every real check-in from its sender until the clock caught up.
        val nowMillis = if (unixSeconds > Long.MAX_VALUE / 1000) Long.MAX_VALUE else unixSeconds * 1000
        if (ProximityBounds.isTooFarAhead(frame.messageId.timestampMillis, nowMillis)) throw ProximityFailure(ProximityError.FUTURE_FRAME)
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
        val selected = queue.sortedWith(compareByDescending<ProximityFrame> { it.status.priority }.thenByDescending { it.messageId }).take(maxFrames)
        queue.removeAll(selected.toSet())
        return selected.map { it.encode() }
    }
    @Synchronized fun memberStatuses(): List<ProximityMemberStatus> = roster.values.sortedBy { it.publicKey.toString() }
    /**
     * Records the pseudonym a provisioned member picked. Trusted provisioning only: the key must be in the
     * roster and the handle inside the shared grammar. It changes what is displayed for that key and nothing else.
     */
    @Synchronized fun provisionDedicatedHandle(sender: ProximityPublicKey, raw: String) {
        if (sender !in allowed) throw ProximityFailure(ProximityError.UNAUTHORIZED)
        dedicatedHandles[sender] = ProximityHandle.dedicated(raw)
    }
    /**
     * Every provisioned member's label. A handle is the member's dedicated pseudonym when one was provisioned,
     * else derived from the key under the organisation's beacon salt, so no name is needed and none is revealed.
     * Equal handles are told apart with a fingerprint of the signing key, and equality is judged over EVERY
     * provisioned key, never over the members seen so far.
     */
    private fun provisionedHandles(): List<Pair<ProximityPublicKey, ProximityHandle>> =
        allowed.map { it to (dedicatedHandles[it] ?: ProximityHandle.generated(salt, it)) }
    /**
     * The label shown for [sender], a provisioned member. A member whose handle equals that of someone who has
     * not checked in yet already carries its fingerprint, so it cannot pass for the absent member. A display
     * label, never an identity: admission stays with the key, the roster and the signature.
     */
    @Synchronized fun label(sender: ProximityPublicKey): ProximityRosterLabel =
        ProximityHandle.labelsFor(provisionedHandles(), listOf(sender)).single()
    /** One display label per member that has checked in, in [memberStatuses] order; see [label]. */
    @Synchronized fun memberLabels(): List<ProximityRosterLabel> =
        ProximityHandle.labelsFor(provisionedHandles(), memberStatuses().map { it.publicKey })
    @Synchronized fun queuedFrameCount(): Int = queue.size
    /** Local and peer traffic share the same priority/capacity policy. Rejection changes nothing. */
    private fun admit(frame: ProximityFrame): Boolean {
        if (queue.any { it.messageId == frame.messageId }) return false
        if (queue.size == capacity) {
            val worst = queue.minWithOrNull(compareBy<ProximityFrame> { it.status.priority }.thenBy { it.messageId })!!
            if (compareValuesBy(frame, worst, { it.status.priority }, { it.messageId }) <= 0) return false
            queue.remove(worst)
        }
        queue.add(frame)
        return true
    }
    private fun updateRoster(frame: ProximityFrame) {
        val previous = roster[frame.senderPublicKey]
        if (previous == null || frame.messageId > previous.messageId) {
            roster[frame.senderPublicKey] = ProximityMemberStatus(frame.senderPublicKey, frame.status, frame.text,
                frame.messageId.timestampMillis, frame.ttlHops, frame.messageId)
        }
    }
}

data class ProximityMemberStatus(val publicKey: ProximityPublicKey, val status: ProximitySafetyStatus,
    val text: String, val timestampMillis: Long, val remainingTtlHops: Int, val messageId: ProximityMessageId)

/** UI submission reports only local queue admission, never remote receipt or assistance dispatch. */
class ProximityCheckInSession(private val controller: BleProximityMeshController,
    private val signer: ProximitySigner, private val nextId: () -> ProximityMessageId) {
    val organisationId: String get() = controller.organisationId
    /** The label this device's check-ins are shown under in this organisation: a pseudonym, never a name. */
    val senderLabel: ProximityRosterLabel get() = controller.label(signer.publicKey)
    @Synchronized fun checkIn(status: ProximitySafetyStatus): ProximityMemberStatus {
        val frame = ProximityFrame.decode(controller.createLocalCheckIn(nextId(), status, "", signer))
        return ProximityMemberStatus(frame.senderPublicKey, frame.status, frame.text,
            frame.messageId.timestampMillis, frame.ttlHops, frame.messageId)
    }
}

/** A single displayed card's lease, not radio membership or a replacement for provisioning. */
class ProximityCheckInLease(private val session: ProximityCheckInSession) : AutoCloseable {
    private var closed = false
    val organisationId: String get() = session.organisationId
    val senderLabel: ProximityRosterLabel get() = session.senderLabel

    /** Check the latest display owner before consuming a message ID or mutating the queue. */
    @Synchronized fun checkIn(currentOrganisationId: String?, status: ProximitySafetyStatus): ProximityMemberStatus {
        if (closed || currentOrganisationId != organisationId ||
            !TrustPolicy.canonicalNonNilUUID(organisationId)) throw ProximityFailure(ProximityError.UNAUTHORIZED)
        return session.checkIn(status)
    }

    @Synchronized override fun close() { closed = true }
}

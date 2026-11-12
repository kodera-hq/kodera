package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature

class BleProximityMeshControllerTests {
    private val organisation = "11111111-1111-4111-8111-111111111111"
    private val salt = ByteArray(32) { 0x42 }; private val now = 1762520100L
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val signer = object : ProximitySigner {
        override val publicKey = ProximityPublicKey(pair.public.encoded.takeLast(32).toByteArray())
        override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run { initSign(pair.private); update(transcript); sign() }
    }
    private fun node(capacity: Int = 128) = BleProximityMeshController(organisation, salt, setOf(signer.publicKey), capacity = capacity)
    private fun id(time: Long) = ProximityMessageId.fromParts(time, ByteArray(10))
    private fun frame(time: Long, status: ProximitySafetyStatus = ProximitySafetyStatus.SAFE, ttl: Int = 3) = ProximityFrame.signed(id(time), ttl, status, "status-$time", signer).encode()
    private fun refuses(reason: ProximityError, block: () -> Unit) {
        try { block(); fail("expected $reason") } catch (error: ProximityFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun membersAreLabelledWithAnOrganisationBoundPseudonymNeverAName() {
        val node = node(); val beacon = node.currentBeacon(now)
        assertTrue(node.memberLabels().isEmpty())
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(now * 1000)))
        val label = node.memberLabels().single()
        assertEquals(signer.publicKey, label.senderPublicKey)
        assertEquals(ProximityHandle.generated(salt, signer.publicKey), label.handle)
        assertEquals(ProximityHandleOrigin.GENERATED, label.handle.origin)
        assertNull(label.fingerprint); assertEquals(label.handle.value, label.display)
        assertTrue(ProximityHandle.isValid(label.handle.value))
        // Another organisation's salt shows another pseudonym for the same key.
        val elsewhere = BleProximityMeshController(organisation, ByteArray(32) { 0x43 }, setOf(signer.publicKey))
        assertNotEquals(label.handle, elsewhere.label(signer.publicKey).handle)
        val session = ProximityCheckInSession(node, signer) { id(now * 1000 + 1) }
        assertEquals(label, session.senderLabel)
        assertEquals(label, ProximityCheckInLease(session).senderLabel)
    }
    /**
     * A member whose handle equals that of a provisioned member who has not checked in yet is already shown
     * with its key fingerprint: it cannot pass for the absent member, and its label does not change when that
     * member appears.
     */
    @Test fun aHandleSharedWithAnAbsentProvisionedMemberAlreadyCarriesItsFingerprint() {
        val otherPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val other = object : ProximitySigner {
            override val publicKey = ProximityPublicKey(otherPair.public.encoded.takeLast(32).toByteArray())
            override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run { initSign(otherPair.private); update(transcript); sign() }
        }
        val node = BleProximityMeshController(organisation, salt, setOf(signer.publicKey, other.publicKey))
        node.provisionDedicatedHandle(signer.publicKey, "north-wing-3")
        node.provisionDedicatedHandle(other.publicKey, "north-wing-3")
        val beacon = node.currentBeacon(now)
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(now * 1000)))
        val alone = node.memberLabels().single()
        assertEquals("north-wing-3", alone.handle.value)
        assertEquals(ProximityHandleOrigin.DEDICATED, alone.handle.origin)
        val fingerprint = alone.fingerprint
        assertNotNull("the handle is shared with a member that has not checked in", fingerprint)
        // Keyed with this organisation's beacon salt: the same key elsewhere shows another one.
        assertTrue(ProximityHandle.fingerprint(salt, signer.publicKey).startsWith(fingerprint!!))
        assertFalse(ProximityHandle.fingerprint(ByteArray(32) { 0x43 }, signer.publicKey).startsWith(fingerprint))
        assertEquals("north-wing-3 [$fingerprint]", alone.display)
        assertEquals(alone, node.label(signer.publicKey))

        node.createLocalCheckIn(id(now * 1000 + 1), ProximitySafetyStatus.SAFE, "", other)
        val both = node.memberLabels()
        assertEquals(2, both.size)
        assertTrue("the first label is unchanged when the other member appears", alone in both)
        assertEquals(2, both.map { it.display }.toSet().size)

        // Provisioning a pseudonym is display metadata for roster keys only.
        val outsider = ProximityPublicKey(ByteArray(32) { 9 })
        refuses(ProximityError.UNAUTHORIZED) { node.provisionDedicatedHandle(outsider, "north-wing-3") }
        refuses(ProximityError.INVALID_HANDLE) { node.provisionDedicatedHandle(signer.publicKey, "North Wing") }
        refuses(ProximityError.UNAUTHORIZED) { node.label(outsider) }
    }
    @Test fun frameDatedPastTheSkewBoundIsRefusedAndCannotMaskRealCheckIns() {
        val node = node(); val beacon = node.currentBeacon(now); val nowMs = now * 1000
        refuses(ProximityError.FUTURE_FRAME) { node.ingestPeerFrame(beacon, now, frame(nowMs + ProximityBounds.MAX_FUTURE_SKEW_MS + 1)) }
        assertTrue(node.memberStatuses().isEmpty()); assertEquals(0, node.queuedFrameCount())
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(nowMs, ProximitySafetyStatus.NEED_ASSISTANCE)))
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(nowMs + ProximityBounds.MAX_FUTURE_SKEW_MS)))
        assertEquals(2, node.queuedFrameCount())
    }
    @Test fun rosterAndQueueFollowTheSharedBounds() {
        val roster = (0 until ProximityBounds.ROSTER_MEMBERS).map { index ->
            ProximityPublicKey(ByteArray(32) { j -> ((if (j % 2 == 0) index else index shr 8) xor j).toByte() }) }.toSet()
        assertEquals(ProximityBounds.ROSTER_MEMBERS, roster.size)
        BleProximityMeshController(organisation, salt, roster, capacity = ProximityBounds.QUEUE_CAPACITY)
        assertThrows(IllegalArgumentException::class.java) {
            BleProximityMeshController(organisation, salt, roster + ProximityPublicKey(ByteArray(32) { -1 })) }
        assertThrows(IllegalArgumentException::class.java) {
            BleProximityMeshController(organisation, salt, roster, capacity = ProximityBounds.QUEUE_CAPACITY + 1) }
    }
    @Test fun threeNodeRelayDecrementsAndStopsAtOne() {
        val first = node(); val second = node(); val third = node(); val beacon = first.currentBeacon(now)
        first.ingestPeerFrame(beacon, now, frame(1, ttl = 3))
        val two = first.drainRelayBatch(1).single(); assertEquals(2, ProximityFrame.decode(two).ttlHops)
        second.ingestPeerFrame(beacon, now, two)
        val one = second.drainRelayBatch(1).single(); assertEquals(1, ProximityFrame.decode(one).ttlHops)
        third.ingestPeerFrame(beacon, now, one)
        assertTrue(third.drainRelayBatch(1).isEmpty()); assertEquals(1, third.memberStatuses().single().remainingTtlHops)
    }
    @Test fun strictPriorityNewestTieBreakAndCapacity() {
        val node = node(2); val beacon = node.currentBeacon(now)
        node.ingestPeerFrame(beacon, now, frame(1)); node.ingestPeerFrame(beacon, now, frame(2, ProximitySafetyStatus.MUSTER_POINT))
        node.ingestPeerFrame(beacon, now, frame(3, ProximitySafetyStatus.NEED_ASSISTANCE)); assertEquals(2, node.queuedFrameCount())
        assertEquals(listOf(ProximitySafetyStatus.NEED_ASSISTANCE, ProximitySafetyStatus.MUSTER_POINT), node.drainRelayBatch(2).map { ProximityFrame.decode(it).status })
        node.ingestPeerFrame(beacon, now, frame(5)); node.ingestPeerFrame(beacon, now, frame(6))
        assertEquals(listOf(6L, 5L), node.drainRelayBatch(2).map { ProximityFrame.decode(it).messageId.timestampMillis })
    }
    @Test fun oldFramesDoNotReplaceRosterAndDuplicatesDoNotRelay() {
        val node = node(); val beacon = node.currentBeacon(now); val latest = frame(100, ProximitySafetyStatus.SAFE)
        node.ingestPeerFrame(beacon, now, latest)
        val before = node.memberStatuses()
        val count = node.queuedFrameCount()
        assertNull(node.ingestPeerFrame(beacon, now, frame(90, ProximitySafetyStatus.NEED_ASSISTANCE)))
        assertEquals(before, node.memberStatuses())
        assertEquals(count, node.queuedFrameCount())
        assertNull(node.ingestPeerFrame(beacon, now, latest))
        assertEquals(count, node.queuedFrameCount())
        assertEquals(listOf(ProximitySafetyStatus.SAFE), node.drainRelayBatch(count).map { ProximityFrame.decode(it).status })
    }
    @Test fun invalidInputDoesNotBurnReplayOrMutateState() {
        val node = node(); val beacon = node.currentBeacon(now); val raw = frame(5)
        refuses(ProximityError.INVALID_BEACON) { node.ingestPeerFrame(ByteArray(8), now, raw) }
        val bad = raw.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        refuses(ProximityError.INVALID_SIGNATURE) { node.ingestPeerFrame(beacon, now, bad) }
        assertTrue(node.memberStatuses().isEmpty()); assertEquals(0, node.queuedFrameCount())
        assertNotNull(node.ingestPeerFrame(beacon, now, raw))
        val stranger = BleProximityMeshController(organisation, salt, setOf(ProximityPublicKey(ByteArray(32))))
        refuses(ProximityError.UNAUTHORIZED) { stranger.ingestPeerFrame(beacon, now, raw) }; assertTrue(stranger.memberStatuses().isEmpty())
    }
    @Test fun localQueueFailureCanBeRetriedWithoutInventingDelivery() {
        val node = node(1)
        node.createLocalCheckIn(id(1), ProximitySafetyStatus.NEED_ASSISTANCE, "", signer)
        refuses(ProximityError.QUEUE_FULL) { node.createLocalCheckIn(id(2), ProximitySafetyStatus.SAFE, "", signer) }
        assertEquals(1L, node.memberStatuses().single().timestampMillis)
        assertEquals(ProximitySafetyStatus.NEED_ASSISTANCE, ProximityFrame.decode(node.drainRelayBatch(1).single()).status)
        node.createLocalCheckIn(id(2), ProximitySafetyStatus.SAFE, "", signer)
        refuses(ProximityError.REPLAY) { node.createLocalCheckIn(id(2), ProximitySafetyStatus.SAFE, "", signer) }
    }
    @Test fun urgentLocalCheckInPreemptsLowerPriorityPendingTraffic() {
        for (pending in listOf(ProximitySafetyStatus.SAFE, ProximitySafetyStatus.MESSAGE_ONLY)) {
            val node = node(1)
            node.createLocalCheckIn(id(1), pending, "", signer)
            node.createLocalCheckIn(id(2), ProximitySafetyStatus.NEED_ASSISTANCE, "", signer)
            assertEquals(1, node.queuedFrameCount())
            assertEquals(ProximitySafetyStatus.NEED_ASSISTANCE, node.memberStatuses().single().status)
            val frame = ProximityFrame.decode(node.drainRelayBatch(1).single())
            assertEquals(ProximitySafetyStatus.NEED_ASSISTANCE, frame.status)
            assertEquals(2L, frame.messageId.timestampMillis)
        }
    }
    @Test fun stalePeerFrameDoesNotConsumeAnotherSendersReplayId() {
        val peerPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val peerSigner = object : ProximitySigner {
            override val publicKey = ProximityPublicKey(peerPair.public.encoded.takeLast(32).toByteArray())
            override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run { initSign(peerPair.private); update(transcript); sign() }
        }
        val node = BleProximityMeshController(organisation, salt, setOf(signer.publicKey, peerSigner.publicKey), replayCapacity = 1)
        val beacon = node.currentBeacon(now)
        node.ingestPeerFrame(beacon, now, frame(100))
        assertNull(node.ingestPeerFrame(beacon, now, frame(90, ProximitySafetyStatus.NEED_ASSISTANCE)))
        val other = ProximityFrame.signed(id(90), 3, ProximitySafetyStatus.SAFE, "", peerSigner).encode()
        assertNotNull(node.ingestPeerFrame(beacon, now, other))
        assertEquals(2, node.memberStatuses().size)
    }
    @Test fun pendingQueueDedupSurvivesReplayCacheEviction() {
        val node = BleProximityMeshController(organisation, salt, setOf(signer.publicKey), capacity = 3, replayCapacity = 1)
        val beacon = node.currentBeacon(now)
        val first = frame(1)
        node.ingestPeerFrame(beacon, now, first)
        node.ingestPeerFrame(beacon, now, frame(2))
        assertNull(node.ingestPeerFrame(beacon, now, first))
        assertEquals(2, node.queuedFrameCount())
    }
    @Test fun backwardsLocalClockCannotQueueAnObsoleteCheckIn() {
        val node = node()
        node.createLocalCheckIn(id(10), ProximitySafetyStatus.SAFE, "", signer)
        node.drainRelayBatch(1)
        refuses(ProximityError.OUT_OF_ORDER) { node.createLocalCheckIn(id(9), ProximitySafetyStatus.NEED_ASSISTANCE, "", signer) }
        assertEquals(0, node.queuedFrameCount())
        assertEquals(10L, node.memberStatuses().single().timestampMillis)
    }
    @Test fun organisationInstancesOwnSeparateQueuesAndBeaconMaterial() {
        val first = node()
        val other = BleProximityMeshController("22222222-2222-4222-8222-222222222222", ByteArray(32) { 1 }, setOf(signer.publicKey))
        first.createLocalCheckIn(id(1), ProximitySafetyStatus.SAFE, "", signer)
        assertEquals(0, other.queuedFrameCount())
        refuses(ProximityError.INVALID_BEACON) { other.ingestPeerFrame(first.currentBeacon(now), now, frame(2)) }
        assertTrue(other.memberStatuses().isEmpty())
    }
    @Test fun uiSessionQueuesRealSignaturesAndReportsAdmissionFailures() {
        val node = node(1); var time = 1L; val session = ProximityCheckInSession(node, signer) { id(time++) }
        assertEquals(ProximitySafetyStatus.SAFE, session.checkIn(ProximitySafetyStatus.SAFE).status)
        ProximityFrame.decode(node.drainRelayBatch(1).single()).verify(setOf(signer.publicKey))
        assertEquals(ProximitySafetyStatus.MUSTER_POINT, session.checkIn(ProximitySafetyStatus.MUSTER_POINT).status)
        assertEquals(ProximitySafetyStatus.NEED_ASSISTANCE, session.checkIn(ProximitySafetyStatus.NEED_ASSISTANCE).status)
        refuses(ProximityError.QUEUE_FULL) { session.checkIn(ProximitySafetyStatus.SAFE) }
    }
    @Test fun disposedOrMismatchedCardLeaseCannotConsumeIdsOrQueueCheckIns() {
        assertThrows(IllegalArgumentException::class.java) {
            BleProximityMeshController("00000000-0000-0000-0000-000000000000", salt, setOf(signer.publicKey))
        }
        val node = node(); var next = 1L
        val session = ProximityCheckInSession(node, signer) { id(next++) }
        val old = ProximityCheckInLease(session)
        for (scope in listOf(null, "22222222-2222-4222-8222-222222222222")) {
            refuses(ProximityError.UNAUTHORIZED) { old.checkIn(scope, ProximitySafetyStatus.SAFE) }
        }
        assertEquals(1L, next); assertEquals(0, node.queuedFrameCount())
        old.checkIn(organisation, ProximitySafetyStatus.SAFE)
        assertEquals(2L, next)
        old.close()
        val replacement = ProximityCheckInLease(session)
        refuses(ProximityError.UNAUTHORIZED) { old.checkIn(organisation, ProximitySafetyStatus.NEED_ASSISTANCE) }
        assertEquals(2L, next)
        replacement.checkIn(organisation, ProximitySafetyStatus.MUSTER_POINT)
        assertEquals(3L, next)
        val packets = node.drainRelayBatch(2)
        assertEquals(2, packets.size)
        packets.forEach { ProximityFrame.decode(it).verify(setOf(signer.publicKey)) }
        replacement.close()
    }

    @Test fun publicBeaconRetaggingWithSharedKeysIsAnExplicitV1ActivationLimit() {
        val otherOrganisation = "22222222-2222-4222-8222-222222222222"
        val shared = BleProximityMeshController(otherOrganisation, ByteArray(32) { 1 }, setOf(signer.publicKey))
        val disjoint = BleProximityMeshController(otherOrganisation, ByteArray(32) { 1 }, setOf(ProximityPublicKey(ByteArray(32))))
        val raw = frame(7)
        refuses(ProximityError.INVALID_BEACON) { shared.ingestPeerFrame(node().currentBeacon(now), now, raw) }
        // v1 signs the frame, not the organisation beacon; this remains a provisioning precondition.
        val admitted = shared.ingestPeerFrame(shared.currentBeacon(now), now, raw)!!
        assertEquals(ProximitySafetyStatus.SAFE, admitted.status)
        admitted.verify(setOf(signer.publicKey))
        refuses(ProximityError.UNAUTHORIZED) { disjoint.ingestPeerFrame(disjoint.currentBeacon(now), now, raw) }
        assertTrue(disjoint.memberStatuses().isEmpty())
    }

    @Test fun defaultSystemClockAcceptsCurrentFrameAndRefusesFarFutureFrame() {
        val node = node()
        val beacon = node.currentBeacon()
        val nowMs = ProximityBounds.currentUnixMillis()
        assertNotNull(node.ingestPeerFrame(beacon, frame(nowMs)))
        refuses(ProximityError.FUTURE_FRAME) {
            node.ingestPeerFrame(beacon, frame(nowMs + ProximityBounds.MAX_FUTURE_SKEW_MS + 60_000L))
        }
    }

}

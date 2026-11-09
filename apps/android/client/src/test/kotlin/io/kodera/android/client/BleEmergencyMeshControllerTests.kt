package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature

class BleEmergencyMeshControllerTests {
    private val organisation = "11111111-1111-4111-8111-111111111111"
    private val salt = ByteArray(32) { 0x42 }; private val now = 1762520100L
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val signer = object : EmergencySigner {
        override val publicKey = EmergencyPublicKey(pair.public.encoded.takeLast(32).toByteArray())
        override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run { initSign(pair.private); update(transcript); sign() }
    }
    private fun node(capacity: Int = 128) = BleEmergencyMeshController(organisation, salt, setOf(signer.publicKey), capacity = capacity)
    private fun id(time: Long) = EmergencyMessageId.fromParts(time, ByteArray(10))
    private fun frame(time: Long, status: EmergencySafetyStatus = EmergencySafetyStatus.SAFE, ttl: Int = 3) = EmergencyFrame.signed(id(time), ttl, status, "status-$time", signer).encode()
    private fun refuses(reason: EmergencyError, block: () -> Unit) {
        try { block(); fail("expected $reason") } catch (error: EmergencyFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun frameDatedPastTheSkewBoundIsRefusedAndCannotMaskRealCheckIns() {
        val node = node(); val beacon = node.currentBeacon(now); val nowMs = now * 1000
        refuses(EmergencyError.FUTURE_FRAME) { node.ingestPeerFrame(beacon, now, frame(nowMs + EmergencyBounds.MAX_FUTURE_SKEW_MS + 1)) }
        assertTrue(node.memberStatuses().isEmpty()); assertEquals(0, node.queuedFrameCount())
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(nowMs, EmergencySafetyStatus.NEED_ASSISTANCE)))
        assertNotNull(node.ingestPeerFrame(beacon, now, frame(nowMs + EmergencyBounds.MAX_FUTURE_SKEW_MS)))
        assertEquals(2, node.queuedFrameCount())
    }
    @Test fun rosterAndQueueFollowTheSharedBounds() {
        val roster = (0 until EmergencyBounds.ROSTER_MEMBERS).map { index ->
            EmergencyPublicKey(ByteArray(32) { j -> ((if (j % 2 == 0) index else index shr 8) xor j).toByte() }) }.toSet()
        assertEquals(EmergencyBounds.ROSTER_MEMBERS, roster.size)
        BleEmergencyMeshController(organisation, salt, roster, capacity = EmergencyBounds.QUEUE_CAPACITY)
        assertThrows(IllegalArgumentException::class.java) {
            BleEmergencyMeshController(organisation, salt, roster + EmergencyPublicKey(ByteArray(32) { -1 })) }
        assertThrows(IllegalArgumentException::class.java) {
            BleEmergencyMeshController(organisation, salt, roster, capacity = EmergencyBounds.QUEUE_CAPACITY + 1) }
    }
    @Test fun threeNodeRelayDecrementsAndStopsAtOne() {
        val first = node(); val second = node(); val third = node(); val beacon = first.currentBeacon(now)
        first.ingestPeerFrame(beacon, now, frame(1, ttl = 3))
        val two = first.drainRelayBatch(1).single(); assertEquals(2, EmergencyFrame.decode(two).ttlHops)
        second.ingestPeerFrame(beacon, now, two)
        val one = second.drainRelayBatch(1).single(); assertEquals(1, EmergencyFrame.decode(one).ttlHops)
        third.ingestPeerFrame(beacon, now, one)
        assertTrue(third.drainRelayBatch(1).isEmpty()); assertEquals(1, third.memberStatuses().single().remainingTtlHops)
    }
    @Test fun strictPriorityNewestTieBreakAndCapacity() {
        val node = node(2); val beacon = node.currentBeacon(now)
        node.ingestPeerFrame(beacon, now, frame(1)); node.ingestPeerFrame(beacon, now, frame(2, EmergencySafetyStatus.MUSTER_POINT))
        node.ingestPeerFrame(beacon, now, frame(3, EmergencySafetyStatus.NEED_ASSISTANCE)); assertEquals(2, node.queuedFrameCount())
        assertEquals(listOf(EmergencySafetyStatus.NEED_ASSISTANCE, EmergencySafetyStatus.MUSTER_POINT), node.drainRelayBatch(2).map { EmergencyFrame.decode(it).status })
        node.ingestPeerFrame(beacon, now, frame(5)); node.ingestPeerFrame(beacon, now, frame(6))
        assertEquals(listOf(6L, 5L), node.drainRelayBatch(2).map { EmergencyFrame.decode(it).messageId.timestampMillis })
    }
    @Test fun oldFramesDoNotReplaceRosterAndDuplicatesDoNotRelay() {
        val node = node(); val beacon = node.currentBeacon(now); val latest = frame(100, EmergencySafetyStatus.SAFE)
        node.ingestPeerFrame(beacon, now, latest)
        val before = node.memberStatuses()
        val count = node.queuedFrameCount()
        assertNull(node.ingestPeerFrame(beacon, now, frame(90, EmergencySafetyStatus.NEED_ASSISTANCE)))
        assertEquals(before, node.memberStatuses())
        assertEquals(count, node.queuedFrameCount())
        assertNull(node.ingestPeerFrame(beacon, now, latest))
        assertEquals(count, node.queuedFrameCount())
        assertEquals(listOf(EmergencySafetyStatus.SAFE), node.drainRelayBatch(count).map { EmergencyFrame.decode(it).status })
    }
    @Test fun invalidInputDoesNotBurnReplayOrMutateState() {
        val node = node(); val beacon = node.currentBeacon(now); val raw = frame(5)
        refuses(EmergencyError.INVALID_BEACON) { node.ingestPeerFrame(ByteArray(8), now, raw) }
        val bad = raw.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        refuses(EmergencyError.INVALID_SIGNATURE) { node.ingestPeerFrame(beacon, now, bad) }
        assertTrue(node.memberStatuses().isEmpty()); assertEquals(0, node.queuedFrameCount())
        assertNotNull(node.ingestPeerFrame(beacon, now, raw))
        val stranger = BleEmergencyMeshController(organisation, salt, setOf(EmergencyPublicKey(ByteArray(32))))
        refuses(EmergencyError.UNAUTHORIZED) { stranger.ingestPeerFrame(beacon, now, raw) }; assertTrue(stranger.memberStatuses().isEmpty())
    }
    @Test fun localQueueFailureCanBeRetriedWithoutInventingDelivery() {
        val node = node(1)
        node.createLocalCheckIn(id(1), EmergencySafetyStatus.NEED_ASSISTANCE, "", signer)
        refuses(EmergencyError.QUEUE_FULL) { node.createLocalCheckIn(id(2), EmergencySafetyStatus.SAFE, "", signer) }
        assertEquals(1L, node.memberStatuses().single().timestampMillis)
        assertEquals(EmergencySafetyStatus.NEED_ASSISTANCE, EmergencyFrame.decode(node.drainRelayBatch(1).single()).status)
        node.createLocalCheckIn(id(2), EmergencySafetyStatus.SAFE, "", signer)
        refuses(EmergencyError.REPLAY) { node.createLocalCheckIn(id(2), EmergencySafetyStatus.SAFE, "", signer) }
    }
    @Test fun urgentLocalCheckInPreemptsLowerPriorityPendingTraffic() {
        for (pending in listOf(EmergencySafetyStatus.SAFE, EmergencySafetyStatus.MESSAGE_ONLY)) {
            val node = node(1)
            node.createLocalCheckIn(id(1), pending, "", signer)
            node.createLocalCheckIn(id(2), EmergencySafetyStatus.NEED_ASSISTANCE, "", signer)
            assertEquals(1, node.queuedFrameCount())
            assertEquals(EmergencySafetyStatus.NEED_ASSISTANCE, node.memberStatuses().single().status)
            val frame = EmergencyFrame.decode(node.drainRelayBatch(1).single())
            assertEquals(EmergencySafetyStatus.NEED_ASSISTANCE, frame.status)
            assertEquals(2L, frame.messageId.timestampMillis)
        }
    }
    @Test fun stalePeerFrameDoesNotConsumeAnotherSendersReplayId() {
        val peerPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val peerSigner = object : EmergencySigner {
            override val publicKey = EmergencyPublicKey(peerPair.public.encoded.takeLast(32).toByteArray())
            override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run { initSign(peerPair.private); update(transcript); sign() }
        }
        val node = BleEmergencyMeshController(organisation, salt, setOf(signer.publicKey, peerSigner.publicKey), replayCapacity = 1)
        val beacon = node.currentBeacon(now)
        node.ingestPeerFrame(beacon, now, frame(100))
        assertNull(node.ingestPeerFrame(beacon, now, frame(90, EmergencySafetyStatus.NEED_ASSISTANCE)))
        val other = EmergencyFrame.signed(id(90), 3, EmergencySafetyStatus.SAFE, "", peerSigner).encode()
        assertNotNull(node.ingestPeerFrame(beacon, now, other))
        assertEquals(2, node.memberStatuses().size)
    }
    @Test fun pendingQueueDedupSurvivesReplayCacheEviction() {
        val node = BleEmergencyMeshController(organisation, salt, setOf(signer.publicKey), capacity = 3, replayCapacity = 1)
        val beacon = node.currentBeacon(now)
        val first = frame(1)
        node.ingestPeerFrame(beacon, now, first)
        node.ingestPeerFrame(beacon, now, frame(2))
        assertNull(node.ingestPeerFrame(beacon, now, first))
        assertEquals(2, node.queuedFrameCount())
    }
    @Test fun backwardsLocalClockCannotQueueAnObsoleteCheckIn() {
        val node = node()
        node.createLocalCheckIn(id(10), EmergencySafetyStatus.SAFE, "", signer)
        node.drainRelayBatch(1)
        refuses(EmergencyError.OUT_OF_ORDER) { node.createLocalCheckIn(id(9), EmergencySafetyStatus.NEED_ASSISTANCE, "", signer) }
        assertEquals(0, node.queuedFrameCount())
        assertEquals(10L, node.memberStatuses().single().timestampMillis)
    }
    @Test fun organisationInstancesOwnSeparateQueuesAndBeaconMaterial() {
        val first = node()
        val other = BleEmergencyMeshController("22222222-2222-4222-8222-222222222222", ByteArray(32) { 1 }, setOf(signer.publicKey))
        first.createLocalCheckIn(id(1), EmergencySafetyStatus.SAFE, "", signer)
        assertEquals(0, other.queuedFrameCount())
        refuses(EmergencyError.INVALID_BEACON) { other.ingestPeerFrame(first.currentBeacon(now), now, frame(2)) }
        assertTrue(other.memberStatuses().isEmpty())
    }
    @Test fun uiSessionQueuesRealSignaturesAndReportsAdmissionFailures() {
        val node = node(1); var time = 1L; val session = EmergencyCheckInSession(node, signer) { id(time++) }
        assertEquals(EmergencySafetyStatus.SAFE, session.checkIn(EmergencySafetyStatus.SAFE).status)
        EmergencyFrame.decode(node.drainRelayBatch(1).single()).verify(setOf(signer.publicKey))
        assertEquals(EmergencySafetyStatus.MUSTER_POINT, session.checkIn(EmergencySafetyStatus.MUSTER_POINT).status)
        assertEquals(EmergencySafetyStatus.NEED_ASSISTANCE, session.checkIn(EmergencySafetyStatus.NEED_ASSISTANCE).status)
        refuses(EmergencyError.QUEUE_FULL) { session.checkIn(EmergencySafetyStatus.SAFE) }
    }
    @Test fun disposedOrMismatchedCardLeaseCannotConsumeIdsOrQueueCheckIns() {
        assertThrows(IllegalArgumentException::class.java) {
            BleEmergencyMeshController("00000000-0000-0000-0000-000000000000", salt, setOf(signer.publicKey))
        }
        val node = node(); var next = 1L
        val session = EmergencyCheckInSession(node, signer) { id(next++) }
        val old = EmergencyCheckInLease(session)
        for (scope in listOf(null, "22222222-2222-4222-8222-222222222222")) {
            refuses(EmergencyError.UNAUTHORIZED) { old.checkIn(scope, EmergencySafetyStatus.SAFE) }
        }
        assertEquals(1L, next); assertEquals(0, node.queuedFrameCount())
        old.checkIn(organisation, EmergencySafetyStatus.SAFE)
        assertEquals(2L, next)
        old.close()
        val replacement = EmergencyCheckInLease(session)
        refuses(EmergencyError.UNAUTHORIZED) { old.checkIn(organisation, EmergencySafetyStatus.NEED_ASSISTANCE) }
        assertEquals(2L, next)
        replacement.checkIn(organisation, EmergencySafetyStatus.MUSTER_POINT)
        assertEquals(3L, next)
        val packets = node.drainRelayBatch(2)
        assertEquals(2, packets.size)
        packets.forEach { EmergencyFrame.decode(it).verify(setOf(signer.publicKey)) }
        replacement.close()
    }

    @Test fun publicBeaconRetaggingWithSharedKeysIsAnExplicitV1ActivationLimit() {
        val otherOrganisation = "22222222-2222-4222-8222-222222222222"
        val shared = BleEmergencyMeshController(otherOrganisation, ByteArray(32) { 1 }, setOf(signer.publicKey))
        val disjoint = BleEmergencyMeshController(otherOrganisation, ByteArray(32) { 1 }, setOf(EmergencyPublicKey(ByteArray(32))))
        val raw = frame(7)
        refuses(EmergencyError.INVALID_BEACON) { shared.ingestPeerFrame(node().currentBeacon(now), now, raw) }
        // v1 signs the frame, not the organisation beacon; this remains a provisioning precondition.
        val admitted = shared.ingestPeerFrame(shared.currentBeacon(now), now, raw)!!
        assertEquals(EmergencySafetyStatus.SAFE, admitted.status)
        admitted.verify(setOf(signer.publicKey))
        refuses(EmergencyError.UNAUTHORIZED) { disjoint.ingestPeerFrame(disjoint.currentBeacon(now), now, raw) }
        assertTrue(disjoint.memberStatuses().isEmpty())
    }

    @Test fun defaultSystemClockAcceptsCurrentFrameAndRefusesFarFutureFrame() {
        val node = node()
        val beacon = node.currentBeacon()
        val nowMs = EmergencyBounds.currentUnixMillis()
        assertNotNull(node.ingestPeerFrame(beacon, frame(nowMs)))
        refuses(EmergencyError.FUTURE_FRAME) {
            node.ingestPeerFrame(beacon, frame(nowMs + EmergencyBounds.MAX_FUTURE_SKEW_MS + 60_000L))
        }
    }

}

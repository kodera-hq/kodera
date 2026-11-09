package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

class AuditEntityScopeTests {
    private val nil = "00000000-0000-0000-0000-000000000000"

    @Test fun formatOnlyUuidCompatibilityDoesNotAdmitNilEntities() {
        assertTrue(TrustPolicy.canonicalUUID(nil))
        assertFalse(TrustPolicy.canonicalNonNilUUID(nil))
        assertTrue(TrustPolicy.canonicalNonNilUUID(Fixtures.organisation))
        for (bad in listOf("", "a".repeat(10000), "11111111-1111-4111-8111-11111111111A")) {
            assertFalse(TrustPolicy.canonicalNonNilUUID(bad))
        }
    }

    @Test fun nilCannotEstablishDiscoveryScopeMediaOrAnAlias() {
        refuses(DomainError.INVALID_ORGANISATION) {
            TrustPolicy.validateDiscovery(Fixtures.discovery(organisationId = nil), Fixtures.environment)
        }
        assertThrows(VoiceCallFailure::class.java) { VoiceCallScope(nil, "channel") }
        assertThrows(DocsWorkspaceFailure::class.java) { DocsWorkspaceScope(nil, "channel") }
        assertThrows(ChannelPollFailure::class.java) { ChannelPollScope(nil, "channel") }
        assertThrows(SoundPreferencesFailure::class.java) { SoundPreferencesScope(nil) }
        val media = MediaState(1, nil, ServiceReadiness.Ready, true)
        assertEquals(MediaPhase.Unavailable(UnavailabilityReason.IDENTITY_REQUIRED), media.phase)
        refuses(DomainError.INVALID_CHANNEL) {
            ChannelIdentity.alias(ChannelReference(Fixtures.organisation, nil, ChannelKind.TEXT, ChannelRoomState.READY),
                Fixtures.validatedDescriptor())
        }
    }

    @Test fun voiceAndDocsScopesRetainExactScalarTextWithinTheirByteBudget() {
        for (valid in listOf("a".repeat(256), "é".repeat(128), "🧭".repeat(64))) {
            assertEquals(valid, VoiceCallScope(Fixtures.organisation, valid).channelId)
            assertEquals(valid, DocsWorkspaceScope(Fixtures.organisation, valid).channelId)
        }
        for (invalid in listOf("a".repeat(257), "é".repeat(129), "🧭".repeat(65), "bad\u200b",
                "bad\u202e", "bad\u2028", "bad\u2029", "\ud800", "\udc00", " padded", "trailing ")) {
            assertThrows(VoiceCallFailure::class.java) { VoiceCallScope(Fixtures.organisation, invalid) }
            assertThrows(DocsWorkspaceFailure::class.java) { DocsWorkspaceScope(Fixtures.organisation, invalid) }
        }
        assertNotEquals(VoiceCallScope(Fixtures.organisation, "é"), VoiceCallScope(Fixtures.organisation, "e\u0301"))
        assertNotEquals(DocsWorkspaceScope(Fixtures.organisation, "é"), DocsWorkspaceScope(Fixtures.organisation, "e\u0301"))
    }
    @Test fun renderedVoiceNamesAndDocsTitlesAreBoundedScalarText() {
        val voice = VoiceCallScope(Fixtures.organisation, "voice")
        val docs = DocsWorkspaceScope(Fixtures.organisation, "text")
        for (valid in listOf("a".repeat(256), "é".repeat(128), "🧭".repeat(64))) {
            assertEquals(valid, VoiceCallParticipant(voice, "peer", valid).displayName)
            assertEquals(valid, DocsPadSummary(docs, "pad", valid, "https://docs.example.test/docs/pad", 1).title)
        }
        // Preserve the existing participant-name whitespace behavior; pad titles remain trimmed.
        assertEquals(" padded ", VoiceCallParticipant(voice, "peer", " padded ").displayName)
        assertThrows(DocsWorkspaceFailure::class.java) {
            DocsPadSummary(docs, "pad", " padded ", "https://docs.example.test/docs/pad", 1)
        }
        for (invalid in listOf("a".repeat(257), "é".repeat(129), "🧭".repeat(65), "bad\u200b",
                "bad\u202e", "bad\u2028", "bad\u2029", "\ud800", "\udc00", "\n", " ")) {
            assertThrows(VoiceCallFailure::class.java) { VoiceCallParticipant(voice, "peer", invalid) }
            assertThrows(DocsWorkspaceFailure::class.java) {
                DocsPadSummary(docs, "pad", invalid, "https://docs.example.test/docs/pad", 1)
            }
        }
    }

    @Test fun voiceRosterCopiesOneBoundedSnapshotWithoutCallingHostileIterator() {
        val scope = VoiceCallScope(Fixtures.organisation, "voice")
        val participant = VoiceCallParticipant(scope, "local", "Local participant")
        var sizeReads = 0; var valueReads = 0
        val changing = object : AbstractList<VoiceCallParticipant>() {
            override val size: Int get() = if (++sizeReads == 1) 1 else Int.MAX_VALUE
            override fun get(index: Int): VoiceCallParticipant { valueReads++; return participant }
            override fun iterator(): Iterator<VoiceCallParticipant> = error("unbounded iterator must not be traversed")
        }
        val state = VoiceCallState.unprovisioned(scope).localPreview(changing)
        assertEquals(1, sizeReads); assertEquals(1, valueReads)
        assertEquals(listOf(participant), state.participants)
        for (failure in listOf(IndexOutOfBoundsException(), ConcurrentModificationException())) {
            val shrinking = object : AbstractList<VoiceCallParticipant>() {
                override val size: Int = 1
                override fun get(index: Int): VoiceCallParticipant = throw failure
            }
            assertThrows(VoiceCallFailure::class.java) { state.replacingParticipants(shrinking) }
            assertEquals(listOf(participant), state.participants)
        }
    }

    @Test fun docsPadCopiesOneBoundedSnapshotWithoutCallingHostileIterator() {
        val scope = DocsWorkspaceScope(Fixtures.organisation, "text")
        val pad = DocsPadSummary(scope, "pad", "Local document", "https://docs.example.test/docs/pad", 1)
        var sizeReads = 0; var valueReads = 0
        val changing = object : AbstractList<DocsPadSummary>() {
            override val size: Int get() = if (++sizeReads == 1) 1 else Int.MAX_VALUE
            override fun get(index: Int): DocsPadSummary { valueReads++; return pad }
            override fun iterator(): Iterator<DocsPadSummary> = error("unbounded iterator must not be traversed")
        }
        val state = DocsWorkspaceState.unprovisioned(scope).localPreview(changing)
        assertEquals(1, sizeReads); assertEquals(1, valueReads)
        assertEquals(listOf(pad), state.pads)
        for (failure in listOf(IndexOutOfBoundsException(), ConcurrentModificationException())) {
            val shrinking = object : AbstractList<DocsPadSummary>() {
                override val size: Int = 1
                override fun get(index: Int): DocsPadSummary = throw failure
            }
            assertThrows(DocsWorkspaceFailure::class.java) { state.replacingPads(shrinking) }
            assertEquals(listOf(pad), state.pads)
        }
    }

}

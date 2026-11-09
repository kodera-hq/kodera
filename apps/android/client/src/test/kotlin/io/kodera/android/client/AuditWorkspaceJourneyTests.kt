package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

/** Cross-controller local journey; no simulated state grants service or device authority. */
class AuditWorkspaceJourneyTests {
    @Test fun workspaceFeaturesComposeAndOldOrganisationCallbacksCannotChangeTheReplacement() {
        val org = "11111111-1111-4111-8111-111111111111"
        val other = "22222222-2222-4222-8222-222222222222"
        val actor = "33333333-3333-4333-8333-333333333333"
        val preferences = WorkspacePreferencesController(WorkspacePreferencesScope(org, "text"))
        val profile = KoderaUserProfile(actor, "Local member", "local.member", "Local preview", KoderaPresenceStatus.OFFLINE, KoderaRoleRank.GUEST)
        val prefsContext = preferences.beginLocalPreview(profile, DocsPadDraft("pad", "text", "Draft", "", 1, actor))
        preferences.selectThemeMode(prefsContext, KoderaThemeMode.LIGHT)
        assertEquals(preferences.snapshot().activeThemeSpec, ShareableThemeCodec.decode(preferences.snapshot().shareCode))
        preferences.updateDocsPad(prefsContext, "Edited draft", "# Literal Markdown")
        assertEquals(2, preferences.snapshot().activeDocsPad!!.revision)
        assertTrue(preferences.snapshot().activeDocsPad!!.exportMarkdown().endsWith("# Literal Markdown"))
        val policy = ChannelIamPolicy("text", "category", false, KoderaRoleRank.MEMBER, KoderaRoleRank.MEMBER, KoderaRoleRank.ADMIN, true, false)
        assertFalse(preferences.evaluateAccess(prefsContext, policy).canRead)
        preferences.updateProfile(prefsContext, "Local member", "local.member", "Local preview", KoderaPresenceStatus.OFFLINE, KoderaRoleRank.MEMBER)
        assertTrue(preferences.evaluateAccess(prefsContext, policy).canCreatePoll)

        val poll = ChannelPollController(ChannelPollScope(org, "text"))
        val pollContext = poll.beginLocalPreview("Choose?", listOf("One", "Two"), true)
        poll.toggleOption(pollContext, 0); poll.toggleOption(pollContext, 1)
        assertEquals(1, poll.snapshot().totalVotes)
        assertEquals(200, poll.snapshot().options.sumOf { it.percentage })
        poll.closePoll(pollContext)
        assertThrows(ChannelPollFailure::class.java) { poll.toggleOption(pollContext, 0) }

        val sound = SoundPreferencesController(SoundPreferencesScope(org))
        val soundContext = sound.beginLocalPreview()
        sound.setVolumePercent(soundContext, 100); sound.setCallDucking(soundContext, true)
        assertEquals(50, sound.snapshot().effectiveGainPercent)
        assertFalse(sound.snapshot().isAudioHardwareActive)

        val voiceScope = VoiceCallScope(org, "voice")
        val voice = VoiceCallController(voiceScope)
        val voiceContext = voice.beginLocalPreview(listOf(VoiceCallParticipant(voiceScope, "local-participant", "Local preview")))
        voice.setDeafened(voiceContext, true)
        assertTrue(voice.snapshot().isDeafened); assertTrue(voice.snapshot().isMuted)
        assertFalse(voice.snapshot().isMicrophoneCapturing)

        val docsScope = DocsWorkspaceScope(org, "text")
        val docs = DocsWorkspaceController(docsScope)
        val docsContext = docs.beginLocalPreview(listOf(DocsPadSummary(docsScope, "pad", "Draft", "https://docs.example.test/docs/pad", 1)))
        assertEquals(1, docs.snapshot().pads.size)

        preferences.switchScope(WorkspacePreferencesScope(other, "text"))
        poll.switchScope(ChannelPollScope(other, "text")); sound.switchScope(SoundPreferencesScope(other))
        voice.switchScope(VoiceCallScope(other, "voice")); docs.switchScope(DocsWorkspaceScope(other, "text"))
        assertThrows(WorkspacePreferencesFailure::class.java) { preferences.updateDocsPad(prefsContext, "Late", "Late") }
        assertThrows(ChannelPollFailure::class.java) { poll.toggleOption(pollContext, 0) }
        assertThrows(SoundPreferencesFailure::class.java) { sound.setMuted(soundContext, true) }
        assertThrows(VoiceCallFailure::class.java) { voice.setMuted(voiceContext, false) }
        assertThrows(DocsWorkspaceFailure::class.java) { docs.replacePads(docsContext, emptyList()) }
        assertNull(preferences.snapshot().profile); assertNull(preferences.snapshot().activeDocsPad)
        assertTrue(docs.snapshot().pads.isEmpty()); assertTrue(voice.snapshot().participants.isEmpty())
        assertNull(poll.previewSnapshot(pollContext)); assertNull(sound.previewSnapshot(soundContext))
        assertNull(voice.previewSnapshot(voiceContext)); assertNull(docs.previewSnapshot(docsContext))
    }
}

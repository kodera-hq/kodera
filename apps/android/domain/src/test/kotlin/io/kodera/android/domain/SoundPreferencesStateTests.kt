package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.pow
import kotlin.math.roundToInt

class SoundPreferencesStateTests {
    private val scope = SoundPreferencesScope("11111111-1111-4111-8111-111111111111")
    private fun preview() = SoundPreferencesState.unprovisioned(scope).localPreview()
    private fun refuses(reason: SoundPreferencesError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: SoundPreferencesFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun packIdsRoundTripExactlyAndDoNotAliasOlderWebIdentifiers() {
        val ids = listOf("givre", "cristal", "atelier", "8bit", "404", "silent")
        assertEquals(ids, SoundPackId.entries.map { it.slug })
        assertEquals(6, ids.toSet().size)
        SoundPackId.entries.forEach { assertSame(it, SoundPackId.fromSlug(it.slug)) }
        assertEquals(listOf(SoundPackId.SILENT), SoundPackId.entries.filter { it.isSilent })
        for (bad in listOf("", "Givre", " givre", "givre ", "givre\n", "kodera-givre", "feutre", "impulsion", "8bit-atelier", "silencieux")) {
            refuses(SoundPreferencesError.INVALID_PACK) { SoundPackId.fromSlug(bad) }
        }
    }
    @Test fun scopeRequiresTheExistingCanonicalUuidGrammar() {
        for (bad in listOf("", "org", " " + scope.organisationId, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")) {
            refuses(SoundPreferencesError.INVALID_SCOPE) { SoundPreferencesScope(bad) }
        }
        assertEquals(scope.organisationId, SoundPreferencesScope(scope.organisationId).organisationId)
    }
    @Test fun unprovisionedAndStoppedValuesAreDefaultsWithoutHardwareOrMutationAuthority() {
        for (state in listOf(SoundPreferencesState.unprovisioned(scope), SoundPreferencesState.stopped(scope))) {
            assertEquals(SoundPackId.GIVRE, state.activePack)
            assertEquals(80, state.volumePercent)
            assertFalse(state.isManuallyMuted); assertFalse(state.isMuted)
            assertFalse(state.isCallDuckingActive); assertEquals(80, state.effectiveGainPercent)
            assertEquals(0, state.activeDuckingDecibels); assertFalse(state.isAudioHardwareActive)
            refuses(SoundPreferencesError.NOT_PREVIEWING) { state.selectingPack(SoundPackId.SILENT) }
            refuses(SoundPreferencesError.NOT_PREVIEWING) { state.withVolumePercent(0) }
            refuses(SoundPreferencesError.NOT_PREVIEWING) { state.withMuted(true) }
            refuses(SoundPreferencesError.NOT_PREVIEWING) { state.withCallDucking(true) }
        }
        refuses(SoundPreferencesError.STOPPED) { SoundPreferencesState.stopped(scope).localPreview() }
    }
    @Test fun allPackVolumeMuteAndDuckingCombinationsHaveBoundedDeterministicPolicyGain() {
        for (pack in SoundPackId.entries) for (volume in 0..100) for (manual in listOf(false, true)) for (duck in listOf(false, true)) {
            val state = preview().selectingPack(pack).withVolumePercent(volume).withMuted(manual).withCallDucking(duck)
            val muted = manual || pack.isSilent || volume == 0
            val gain = if (muted) 0 else if (duck) (volume + 1) / 2 else volume
            assertEquals(muted, state.isMuted); assertEquals(muted, state.isOutputMuted)
            assertEquals(manual, state.isManuallyMuted); assertEquals(duck, state.isCallDuckingActive)
            assertEquals(gain, state.effectiveGainPercent)
            assertEquals(if (duck && !muted) -6 else 0, state.activeDuckingDecibels)
            assertTrue(state.effectiveGainPercent in 0..100)
            assertFalse(state.isAudioHardwareActive)
        }
        assertEquals(40, preview().withCallDucking(true).effectiveGainPercent)
        assertEquals(1, preview().withVolumePercent(1).withCallDucking(true).effectiveGainPercent)
        assertEquals(50, preview().withVolumePercent(100).withCallDucking(true).effectiveGainPercent)
        for (volume in 0..100) {
            val reference = (volume * 10.0.pow(-6.0 / 20.0)).roundToInt()
            assertEquals(reference, preview().withVolumePercent(volume).withCallDucking(true).effectiveGainPercent)
        }
    }
    @Test fun nonSilentSelectionRestoresZeroVolumeWithoutClearingManualMute() {
        val original = preview().selectingPack(SoundPackId.SILENT).withVolumePercent(0).withMuted(true).withCallDucking(true)
        val selected = original.selectingPack(SoundPackId.ATELIER)
        assertEquals(80, selected.volumePercent); assertTrue(selected.isManuallyMuted)
        assertTrue(selected.isMuted); assertEquals(0, selected.effectiveGainPercent)
        val unmuted = selected.withMuted(false)
        assertFalse(unmuted.isMuted); assertEquals(40, unmuted.effectiveGainPercent)
        assertTrue(original.activePack.isSilent); assertEquals(0, original.volumePercent)
    }
    @Test fun clearingManualMuteDoesNotPretendSilentOrZeroVolumeIsAudible() {
        val silent = preview().selectingPack(SoundPackId.SILENT).withMuted(true).withMuted(false)
        assertFalse(silent.isManuallyMuted); assertTrue(silent.isMuted)
        assertEquals(0, silent.withCallDucking(true).activeDuckingDecibels)
        val zero = preview().withVolumePercent(0).withMuted(true).withMuted(false)
        assertTrue(zero.isMuted); assertEquals(0, zero.effectiveGainPercent)
    }
    @Test fun invalidVolumeCannotChangeExistingImmutableValuesAndFreshPreviewResetsPreferences() {
        val state = preview().selectingPack(SoundPackId.GLITCH_404).withVolumePercent(23).withMuted(true).withCallDucking(true)
        for (bad in listOf(Int.MIN_VALUE, -1, 101, Int.MAX_VALUE)) {
            refuses(SoundPreferencesError.INVALID_VOLUME) { state.withVolumePercent(bad) }
            assertEquals(23, state.volumePercent); assertEquals(SoundPackId.GLITCH_404, state.activePack)
        }
        val reset = state.localPreview()
        assertEquals(SoundPackId.GIVRE, reset.activePack); assertEquals(80, reset.volumePercent)
        assertFalse(reset.isManuallyMuted); assertFalse(reset.isCallDuckingActive)
    }
}

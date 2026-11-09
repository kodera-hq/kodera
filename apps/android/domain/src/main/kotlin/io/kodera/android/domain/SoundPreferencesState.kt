package io.kodera.android.domain

enum class SoundPreferencesError { INVALID_PACK, INVALID_SCOPE, INVALID_VOLUME, UNAUTHORISED_UPDATE, NOT_PREVIEWING, STOPPED, OBSERVER_LIMIT }
class SoundPreferencesFailure(val reason: SoundPreferencesError) : Exception(reason.name)

/** Native preference identifiers. These are not aliases for the existing Web renderer pack IDs. */
enum class SoundPackId(val slug: String) {
    GIVRE("givre"), CRISTAL("cristal"), ATELIER("atelier"), ARCADE_8BIT("8bit"), GLITCH_404("404"), SILENT("silent");

    val isSilent: Boolean get() = this == SILENT
    companion object {
        fun fromSlug(slug: String): SoundPackId = entries.firstOrNull { it.slug == slug }
            ?: throw SoundPreferencesFailure(SoundPreferencesError.INVALID_PACK)
    }
}

/** Correlation metadata only; a canonical organisation ID establishes no service authority. */
data class SoundPreferencesScope(val organisationId: String) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) throw SoundPreferencesFailure(SoundPreferencesError.INVALID_SCOPE)
    }
}

enum class SoundPreferencesPhase { UNPROVISIONED, LOCAL_PREVIEW_ONLY, STOPPED }

/** Immutable local policy values, never a report of measured output or active audio hardware. */
class SoundPreferencesState private constructor(val scope: SoundPreferencesScope, val phase: SoundPreferencesPhase,
    val activePack: SoundPackId = SoundPackId.GIVRE, val volumePercent: Int = DEFAULT_VOLUME_PERCENT,
    val isManuallyMuted: Boolean = false, val isCallDuckingActive: Boolean = false) {
    val isMuted: Boolean get() = isManuallyMuted || activePack.isSilent || volumePercent == 0
    val isOutputMuted: Boolean get() = isMuted
    val isAudioHardwareActive: Boolean get() = false
    // Integer-rounded -6 dB policy for the bounded 0..100 range, not a DSP measurement.
    val effectiveGainPercent: Int get() = if (isMuted) 0 else if (isCallDuckingActive) (volumePercent + 1) / 2 else volumePercent
    val activeDuckingDecibels: Int get() = if (isCallDuckingActive && !isMuted) -6 else 0

    fun localPreview(): SoundPreferencesState {
        if (phase == SoundPreferencesPhase.STOPPED) throw SoundPreferencesFailure(SoundPreferencesError.STOPPED)
        return SoundPreferencesState(scope, SoundPreferencesPhase.LOCAL_PREVIEW_ONLY)
    }
    fun selectingPack(pack: SoundPackId): SoundPreferencesState {
        requirePreview()
        val volume = if (!pack.isSilent && volumePercent == 0) DEFAULT_VOLUME_PERCENT else volumePercent
        return SoundPreferencesState(scope, phase, pack, volume, isManuallyMuted, isCallDuckingActive)
    }
    fun withVolumePercent(value: Int): SoundPreferencesState {
        requirePreview()
        if (value !in 0..100) throw SoundPreferencesFailure(SoundPreferencesError.INVALID_VOLUME)
        return SoundPreferencesState(scope, phase, activePack, value, isManuallyMuted, isCallDuckingActive)
    }
    fun withMuted(value: Boolean): SoundPreferencesState {
        requirePreview()
        return SoundPreferencesState(scope, phase, activePack, volumePercent, value, isCallDuckingActive)
    }
    fun withCallDucking(value: Boolean): SoundPreferencesState {
        requirePreview()
        return SoundPreferencesState(scope, phase, activePack, volumePercent, isManuallyMuted, value)
    }
    private fun requirePreview() {
        if (phase != SoundPreferencesPhase.LOCAL_PREVIEW_ONLY) throw SoundPreferencesFailure(SoundPreferencesError.NOT_PREVIEWING)
    }
    companion object {
        const val DEFAULT_VOLUME_PERCENT = 80
        fun unprovisioned(scope: SoundPreferencesScope) = SoundPreferencesState(scope, SoundPreferencesPhase.UNPROVISIONED)
        fun stopped(scope: SoundPreferencesScope) = SoundPreferencesState(scope, SoundPreferencesPhase.STOPPED)
    }
}

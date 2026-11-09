package io.kodera.android.domain

data class MediaAttempt(
    val attemptId: String, val generation: Long, val organisationId: String, val matrixRoomId: String
)

sealed interface MediaPhase {
    data class Unavailable(val reason: UnavailabilityReason) : MediaPhase
    data object Idle : MediaPhase
    data object Joining : MediaPhase
    data object Joined : MediaPhase
    data object Reconnecting : MediaPhase
    data object Ended : MediaPhase
}

/** Local observations only; none verifies a token, real transport or cross-device media. */
sealed interface MediaEvent {
    data class RequestJoin(val attempt: MediaAttempt) : MediaEvent
    data class GrantReceived(val attempt: MediaAttempt) : MediaEvent
    data class TransportConnected(val attempt: MediaAttempt) : MediaEvent
    data class TransportLost(val attempt: MediaAttempt) : MediaEvent
    data class TransportFailed(val attempt: MediaAttempt) : MediaEvent
    data class CameraIntent(val enabled: Boolean) : MediaEvent
    data class CameraPermission(val granted: Boolean) : MediaEvent
    data class CameraPublication(val attempt: MediaAttempt, val active: Boolean) : MediaEvent
    data object Leave : MediaEvent
    data object Revoke : MediaEvent
    data object SignOut : MediaEvent
}

class MediaState private constructor(
    private val generation: Long,
    private val organisationId: String,
    val phase: MediaPhase,
    val attempt: MediaAttempt?,
    val cameraIntent: Boolean,
    private val cameraPermission: Boolean,
    val cameraPublished: Boolean
) {
    constructor(generation: Long, organisationId: String, readiness: ServiceReadiness, adapterAvailable: Boolean) :
        this(generation, organisationId, initialPhase(generation, organisationId, readiness, adapterAvailable),
            null, false, false, false)

    fun applying(event: MediaEvent): MediaState {
        if (phase == MediaPhase.Ended) return this
        return when (event) {
            is MediaEvent.RequestJoin -> {
                val candidate = event.attempt
                if (phase != MediaPhase.Idle || candidate.generation != generation ||
                    candidate.organisationId != organisationId || candidate.attemptId.isEmpty() ||
                    candidate.matrixRoomId.isEmpty()) this
                else withState(phase = MediaPhase.Joining, attempt = candidate,
                    cameraIntent = false, cameraPermission = false, cameraPublished = false)
            }
            is MediaEvent.GrantReceived -> this
            is MediaEvent.TransportConnected -> {
                if (attempt != event.attempt || (phase != MediaPhase.Joining && phase != MediaPhase.Reconnecting)) this
                else withState(phase = MediaPhase.Joined)
            }
            is MediaEvent.TransportLost -> {
                if (attempt != event.attempt || phase != MediaPhase.Joined) this
                else withState(phase = MediaPhase.Reconnecting, cameraPublished = false)
            }
            is MediaEvent.TransportFailed -> if (attempt != event.attempt) this else ended()
            is MediaEvent.CameraIntent -> {
                if (attempt == null) this
                else withState(cameraIntent = event.enabled, cameraPublished = cameraPublished && event.enabled)
            }
            is MediaEvent.CameraPermission -> {
                if (attempt == null) this
                else withState(cameraPermission = event.granted, cameraPublished = cameraPublished && event.granted)
            }
            is MediaEvent.CameraPublication -> {
                if (attempt != event.attempt || phase != MediaPhase.Joined) this
                else withState(cameraPublished = event.active && cameraIntent && cameraPermission)
            }
            MediaEvent.Leave, MediaEvent.Revoke, MediaEvent.SignOut -> ended()
        }
    }

    private fun ended(): MediaState = withState(phase = MediaPhase.Ended, attempt = null,
        cameraIntent = false, cameraPermission = false, cameraPublished = false)

    private fun withState(
        phase: MediaPhase = this.phase, attempt: MediaAttempt? = this.attempt,
        cameraIntent: Boolean = this.cameraIntent, cameraPermission: Boolean = this.cameraPermission,
        cameraPublished: Boolean = this.cameraPublished
    ): MediaState = MediaState(generation, organisationId, phase, attempt, cameraIntent, cameraPermission, cameraPublished)

    override fun equals(other: Any?): Boolean = other is MediaState &&
        generation == other.generation && organisationId == other.organisationId && phase == other.phase &&
        attempt == other.attempt && cameraIntent == other.cameraIntent &&
        cameraPermission == other.cameraPermission && cameraPublished == other.cameraPublished
    override fun hashCode(): Int =
        listOf(generation, organisationId, phase, attempt, cameraIntent, cameraPermission, cameraPublished).hashCode()

    companion object {
        private fun initialPhase(
            generation: Long, organisationId: String, readiness: ServiceReadiness, adapterAvailable: Boolean
        ): MediaPhase {
            if (!adapterAvailable) return MediaPhase.Unavailable(UnavailabilityReason.NOT_CONFIGURED)
            if (generation <= 0 || !TrustPolicy.canonicalNonNilUUID(organisationId)) {
                return MediaPhase.Unavailable(UnavailabilityReason.IDENTITY_REQUIRED)
            }
            return when (readiness) {
                ServiceReadiness.Ready -> MediaPhase.Idle
                ServiceReadiness.Pending -> MediaPhase.Unavailable(UnavailabilityReason.SERVICE_UNAVAILABLE)
                ServiceReadiness.Unknown -> MediaPhase.Unavailable(UnavailabilityReason.UNSUPPORTED_CONTRACT)
                is ServiceReadiness.Unavailable -> MediaPhase.Unavailable(readiness.reason)
            }
        }
    }
}

package io.kodera.android.client

/**
 * What organisation entry shows for a discovery state. The screen maps each case to its string resources and
 * offers sign-in only for [Found], whose issuer discovery has already admitted.
 */
sealed interface DiscoveryPresentation {
    data object Ready : DiscoveryPresentation
    data object Searching : DiscoveryPresentation
    data object Cancelled : DiscoveryPresentation
    /** Core answered with zero results. Not an error: nothing matched, or nothing is eligible yet. */
    data object NoOrganisation : DiscoveryPresentation
    /** One organisation: sign-in goes to its realm. */
    data class Found(val organisation: AnonymousOrganisationMetadata) : DiscoveryPresentation
    /** Several organisations matched; the member picks one, which then becomes [Found]. */
    data class SeveralCandidates(val organisations: List<AnonymousOrganisationMetadata>) : DiscoveryPresentation
    /** A quota answer (429 `rate-limited`). Nothing retries it; the member searches again later. */
    data object TryAgainLater : DiscoveryPresentation
    /** No answer from Core: offline, timed out, or the connection could not be established. */
    data class NetworkError(val reason: TransportFailure) : DiscoveryPresentation
    /** Core answered that it cannot serve discovery now (500, 503 or a status it does not document). */
    data object ServiceUnavailable : DiscoveryPresentation
    /** Core refused the request itself (one of [RequestRejection]). */
    data object RequestRefused : DiscoveryPresentation
    /** An answer the app cannot use, including an issuer outside the configured origins. */
    data object InvalidResponse : DiscoveryPresentation
    data object InvalidInput : DiscoveryPresentation
    data object NotConfigured : DiscoveryPresentation

    /** The issuer a sign-in may start against: only a found organisation's. */
    val signInIssuer: String? get() = (this as? Found)?.organisation?.issuer

    companion object {
        fun of(state: AnonymousDiscoveryState): DiscoveryPresentation = when (state) {
            AnonymousDiscoveryState.Editing -> Ready
            AnonymousDiscoveryState.Loading -> Searching
            AnonymousDiscoveryState.Cancelled -> Cancelled
            AnonymousDiscoveryState.NoMatch -> NoOrganisation
            is AnonymousDiscoveryState.Selected -> Found(state.metadata)
            is AnonymousDiscoveryState.Choosing -> SeveralCandidates(state.choices)
            is AnonymousDiscoveryState.Unavailable -> when (val failure = state.failure) {
                is DiscoveryFailure.RateLimited -> TryAgainLater
                is DiscoveryFailure.Transport -> NetworkError(failure.reason)
                is DiscoveryFailure.TemporarilyUnavailable, is DiscoveryFailure.InternalServiceError,
                DiscoveryFailure.UnsupportedService -> ServiceUnavailable
                is DiscoveryFailure.RejectedRequest -> RequestRefused
                DiscoveryFailure.ProtocolViolation -> InvalidResponse
                DiscoveryFailure.InvalidInput -> InvalidInput
                DiscoveryFailure.NotConfigured -> NotConfigured
            }
        }
    }
}

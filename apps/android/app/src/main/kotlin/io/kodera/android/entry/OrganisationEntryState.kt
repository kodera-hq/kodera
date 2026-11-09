package io.kodera.android.entry

import io.kodera.android.client.AnonymousDiscoveryState
import io.kodera.android.client.DiscoveryFailure

/** In-memory anonymous metadata presentation only; no identity or membership is represented. */
data class OrganisationEntryState(
    val organisationSlug: String = "",
    val discovery: AnonymousDiscoveryState = AnonymousDiscoveryState.Unavailable(DiscoveryFailure.NotConfigured),
    val configured: Boolean = false,
    val active: Boolean = false,
) {
    val isLoading: Boolean get() = discovery == AnonymousDiscoveryState.Loading
    val canonicalSlug: Boolean get() {
        fun alphaNumeric(c: Char) = c in 'a'..'z' || c in '0'..'9'
        return organisationSlug.length in 5..20 && alphaNumeric(organisationSlug.first()) &&
            alphaNumeric(organisationSlug.last()) && organisationSlug.all { alphaNumeric(it) || it == '-' }
    }
    val canLookup: Boolean get() = configured && active && !isLoading && canonicalSlug
}

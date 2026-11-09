package io.kodera.android.client

import java.util.UUID

class DiscoveryTicket internal constructor(internal val queryId: UUID, internal val lifecycleId: UUID)
sealed interface AnonymousDiscoveryState {
    data object Editing : AnonymousDiscoveryState
    data object Loading : AnonymousDiscoveryState
    data object NoMatch : AnonymousDiscoveryState
    data object Cancelled : AnonymousDiscoveryState
    data class Choosing(val choices: List<AnonymousOrganisationMetadata>) : AnonymousDiscoveryState
    data class Selected(val metadata: AnonymousOrganisationMetadata) : AnonymousDiscoveryState
    data class Unavailable(val failure: DiscoveryFailure) : AnonymousDiscoveryState
}
/** Anonymous metadata state only; the Call owner performs network cancellation separately. */
class DiscoveryState {
    private val lock = Any()
    private var current: DiscoveryTicket? = null
    private var lifecycleId = UUID.randomUUID()
    private var stored: AnonymousDiscoveryState = AnonymousDiscoveryState.Editing
    val value: AnonymousDiscoveryState get() = synchronized(lock) { stored }
    fun begin(): DiscoveryTicket = synchronized(lock) {
        DiscoveryTicket(UUID.randomUUID(), lifecycleId).also { current = it; stored = AnonymousDiscoveryState.Loading }
    }
    fun receive(outcome: AnonymousDiscoveryOutcome, ticket: DiscoveryTicket) = synchronized(lock) {
        if (current !== ticket || ticket.lifecycleId != lifecycleId) return@synchronized
        current = null
        stored = when (outcome) {
            is AnonymousDiscoveryOutcome.Result -> when (val result = outcome.value) {
                AnonymousDiscoveryResult.NoMatch -> AnonymousDiscoveryState.NoMatch
                is AnonymousDiscoveryResult.Single -> AnonymousDiscoveryState.Selected(result.metadata)
                is AnonymousDiscoveryResult.Multiple -> AnonymousDiscoveryState.Choosing(immutableCopy(result.choices))
            }
            is AnonymousDiscoveryOutcome.Failure -> AnonymousDiscoveryState.Unavailable(outcome.failure)
            AnonymousDiscoveryOutcome.Cancelled -> AnonymousDiscoveryState.Cancelled
        }
    }
    fun cancel() = synchronized(lock) { current = null; stored = AnonymousDiscoveryState.Cancelled }
    fun reset() = synchronized(lock) { lifecycleId = UUID.randomUUID(); current = null; stored = AnonymousDiscoveryState.Editing }
    fun select(organisationId: String) = synchronized(lock) {
        val choices = (stored as? AnonymousDiscoveryState.Choosing)?.choices ?: refused()
        val matches = choices.filter { it.organisationId == organisationId }
        if (matches.size != 1) refused()
        stored = AnonymousDiscoveryState.Selected(matches.single())
    }
}

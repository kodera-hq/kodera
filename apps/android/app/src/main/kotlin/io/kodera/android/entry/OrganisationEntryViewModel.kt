package io.kodera.android.entry

import android.app.Application
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import io.kodera.android.client.AnonymousDiscoveryOutcome
import io.kodera.android.client.CoreDiscoveryClient
import io.kodera.android.client.DiscoveryFailure
import io.kodera.android.client.DiscoveryOperation
import io.kodera.android.client.DiscoveryState
import io.kodera.android.client.DiscoveryTicket
import java.util.UUID

/** One protected client per retained model; no saved state, arbitrary factory or automatic request. */
class OrganisationEntryViewModel(application: Application) : AndroidViewModel(application) {
    private val configuration = DeploymentConfiguration.read().discovery
    private val client = configuration?.let { CoreDiscoveryClient(it) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val reducer = DiscoveryState()
    private var operation: DiscoveryOperation? = null
    private var currentTicket: DiscoveryTicket? = null
    private var lifecycleId = UUID.randomUUID()
    private var activeOwner: Any? = null
    private var cleared = false
    var state by mutableStateOf(OrganisationEntryState(configured = configuration != null))
        private set

    init { if (configuration == null) present(DiscoveryFailure.NotConfigured) else publish() }
    private fun requireMain() { check(Looper.myLooper() == Looper.getMainLooper()) }
    fun activate(owner: Any) {
        requireMain(); if (cleared) return
        activeOwner = owner; publish()
    }
    fun deactivate(owner: Any) {
        requireMain(); if (activeOwner !== owner) return
        activeOwner = null; fenceWork(); reducer.reset()
        if (configuration == null) present(DiscoveryFailure.NotConfigured) else publish()
    }
    fun updateSlug(value: String) {
        requireMain(); if (cleared || value == state.organisationSlug) return
        fenceWork(); reducer.reset(); state = state.copy(organisationSlug = value)
        if (configuration == null) present(DiscoveryFailure.NotConfigured) else publish()
    }
    fun lookup() {
        requireMain(); if (cleared || !state.canLookup) return
        val ownedClient = client ?: return
        val owner = activeOwner ?: return
        fenceWork()
        val ticket = reducer.begin(); currentTicket = ticket
        val capturedLifecycle = lifecycleId
        val slug = state.organisationSlug
        publish()
        val returned = ownedClient.discover(slug) { outcome ->
            mainHandler.post {
                if (!cleared && activeOwner === owner && lifecycleId == capturedLifecycle && currentTicket === ticket) {
                    currentTicket = null; operation = null
                    reducer.receive(outcome, ticket); publish()
                }
            }
        }
        if (!cleared && activeOwner === owner && lifecycleId == capturedLifecycle && currentTicket === ticket) operation = returned
        else returned.cancel()
    }
    fun cancelLookup() {
        requireMain(); if (cleared) return
        fenceWork(); reducer.cancel(); publish()
    }
    fun clear() {
        requireMain(); if (cleared) return
        fenceWork(); reducer.reset(); state = state.copy(organisationSlug = "")
        if (configuration == null) present(DiscoveryFailure.NotConfigured) else publish()
    }
    fun select(organisationId: String) {
        requireMain(); if (cleared || activeOwner == null) return
        try { reducer.select(organisationId); publish() }
        catch (_: io.kodera.android.client.DiscoveryDecodingException) { present(DiscoveryFailure.ProtocolViolation) }
    }
    private fun fenceWork() {
        currentTicket = null; lifecycleId = UUID.randomUUID()
        val retired = operation; operation = null; retired?.cancel()
    }
    private fun publish() {
        requireMain()
        state = state.copy(discovery = reducer.value, configured = configuration != null && !cleared, active = activeOwner != null && !cleared)
    }
    private fun present(failure: DiscoveryFailure) {
        fenceWork(); val ticket = reducer.begin()
        reducer.receive(AnonymousDiscoveryOutcome.Failure(failure), ticket); publish()
    }
    override fun onCleared() {
        requireMain(); cleared = true; activeOwner = null; fenceWork(); reducer.reset(); publish()
        client?.close()
        super.onCleared()
    }
}

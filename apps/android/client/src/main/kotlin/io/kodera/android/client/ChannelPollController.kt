package io.kodera.android.client

import io.kodera.android.domain.ChannelPollError
import io.kodera.android.domain.ChannelPollFailure
import io.kodera.android.domain.ChannelPollPhase
import io.kodera.android.domain.ChannelPollScope
import io.kodera.android.domain.ChannelPollState

/** Opaque local preview lifetime, not authentication or poll-service voting authority. */
class ChannelPollContext internal constructor(private val owner: Any, private val generation: Any,
    val scope: ChannelPollScope) {
    internal fun matches(owner: Any, generation: Any, scope: ChannelPollScope) =
        this.owner === owner && this.generation === generation && this.scope == scope
}

/** Serialized local voter reducer. No poll backend, account or remote result source is supplied. */
class ChannelPollController(scope: ChannelPollScope) {
    private val owner = Any()
    private var generation = Any()
    private var state = ChannelPollState.unprovisioned(scope)
    private val observers = mutableMapOf<Any, () -> Unit>()

    @Synchronized fun snapshot(): ChannelPollState = state
    @Synchronized fun beginLocalPreview(question: String, options: List<String>, allowsMultipleChoices: Boolean): ChannelPollContext {
        val next = state.localPreview(question, options, allowsMultipleChoices)
        generation = Any()
        state = next
        val context = ChannelPollContext(owner, generation, state.scope)
        publish()
        return context
    }
    @Synchronized fun toggleOption(context: ChannelPollContext?, optionId: Int) {
        requireContext(context)
        state = state.togglingOption(optionId)
        publish()
    }
    @Synchronized fun closePoll(context: ChannelPollContext?) {
        requireContext(context)
        state = state.closing()
        publish()
    }
    /** Trusted owner teardown is always available, including after a poll is closed. */
    @Synchronized fun leave() {
        if (state.phase == ChannelPollPhase.STOPPED) return
        clear(ChannelPollState.unprovisioned(state.scope))
    }
    @Synchronized fun leavePreview(context: ChannelPollContext?) { if (valid(context)) leave() }
    @Synchronized fun stop() = clear(ChannelPollState.stopped(state.scope))
    @Synchronized fun switchScope(scope: ChannelPollScope) {
        if (state.phase == ChannelPollPhase.STOPPED) throw ChannelPollFailure(ChannelPollError.STOPPED)
        clear(ChannelPollState.unprovisioned(scope))
    }
    @Synchronized fun previewSnapshot(context: ChannelPollContext?): ChannelPollState? = if (valid(context)) state else null
    @Synchronized fun observe(context: ChannelPollContext?, observer: (ChannelPollState?) -> Unit): AutoCloseable {
        if (observers.size >= MAX_OBSERVERS) throw ChannelPollFailure(ChannelPollError.OBSERVER_LIMIT)
        val key = Any()
        val notify = { observer(previewSnapshot(context)) }
        observers[key] = notify
        try { notify() } catch (error: Throwable) { observers.remove(key); throw error }
        return AutoCloseable { synchronized(this) { observers.remove(key) } }
    }
    private fun valid(context: ChannelPollContext?) = state.phase == ChannelPollPhase.LOCAL_PREVIEW_ONLY &&
        context?.matches(owner, generation, state.scope) == true
    private fun requireContext(context: ChannelPollContext?) {
        if (!valid(context)) throw ChannelPollFailure(ChannelPollError.UNAUTHORISED_UPDATE)
    }
    private fun clear(next: ChannelPollState) {
        generation = Any()
        state = next
        publish()
    }
    private fun publish() { observers.values.toList().forEach { runCatching { it() } } }
    companion object { const val MAX_OBSERVERS = 64 }
}

/** Context-bound UI handle; an obsolete card cannot mutate or clear a replacement preview. */
class ChannelPollSession(private val controller: ChannelPollController, private val context: ChannelPollContext) {
    val scope: ChannelPollScope get() = context.scope
    fun snapshot(): ChannelPollState? = controller.previewSnapshot(context)
    fun observe(observer: (ChannelPollState?) -> Unit): AutoCloseable = controller.observe(context, observer)
    fun toggleOption(optionId: Int) = controller.toggleOption(context, optionId)
    fun closePoll() = controller.closePoll(context)
    fun leave() = controller.leavePreview(context)
}

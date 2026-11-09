package io.kodera.android.client

import io.kodera.android.domain.SoundPackId
import io.kodera.android.domain.SoundPreferencesError
import io.kodera.android.domain.SoundPreferencesFailure
import io.kodera.android.domain.SoundPreferencesPhase
import io.kodera.android.domain.SoundPreferencesScope
import io.kodera.android.domain.SoundPreferencesState

/** Opaque local operation fence, not membership, a provider credential or audio authority. */
class SoundPreferencesContext internal constructor(private val owner: Any, private val generation: Any,
    val scope: SoundPreferencesScope) {
    internal fun matches(owner: Any, generation: Any, scope: SoundPreferencesScope) =
        this.owner === owner && this.generation === generation && this.scope == scope
}

/** Local in-memory preferences only. No renderer, persistence or hardware is provisioned. */
class SoundPreferencesController(scope: SoundPreferencesScope) {
    private val owner = Any()
    private var generation = Any()
    private var state = SoundPreferencesState.unprovisioned(scope)
    private val observers = mutableMapOf<Any, () -> Unit>()

    @Synchronized fun snapshot(): SoundPreferencesState = state
    @Synchronized fun beginLocalPreview(): SoundPreferencesContext {
        val next = state.localPreview()
        generation = Any()
        state = next
        val context = SoundPreferencesContext(owner, generation, state.scope)
        publish()
        return context
    }
    @Synchronized fun selectPack(context: SoundPreferencesContext?, pack: SoundPackId) {
        requireContext(context)
        state = state.selectingPack(pack)
        publish()
    }
    @Synchronized fun setVolumePercent(context: SoundPreferencesContext?, value: Int) {
        requireContext(context)
        state = state.withVolumePercent(value)
        publish()
    }
    @Synchronized fun setMuted(context: SoundPreferencesContext?, value: Boolean) {
        requireContext(context)
        state = state.withMuted(value)
        publish()
    }
    @Synchronized fun setCallDucking(context: SoundPreferencesContext?, value: Boolean) {
        requireContext(context)
        state = state.withCallDucking(value)
        publish()
    }
    @Synchronized fun leave() {
        if (state.phase == SoundPreferencesPhase.STOPPED) return
        clear(SoundPreferencesState.unprovisioned(state.scope))
    }
    /** Disposal of one preview lifetime cannot clear its replacement. */
    @Synchronized fun leavePreview(context: SoundPreferencesContext?) { if (valid(context)) leave() }
    @Synchronized fun stop() = clear(SoundPreferencesState.stopped(state.scope))
    @Synchronized fun switchScope(scope: SoundPreferencesScope) {
        if (state.phase == SoundPreferencesPhase.STOPPED) throw SoundPreferencesFailure(SoundPreferencesError.STOPPED)
        clear(SoundPreferencesState.unprovisioned(scope))
    }
    @Synchronized fun previewSnapshot(context: SoundPreferencesContext?): SoundPreferencesState? = if (valid(context)) state else null
    @Synchronized fun observe(context: SoundPreferencesContext?, observer: (SoundPreferencesState?) -> Unit): AutoCloseable {
        if (observers.size >= MAX_OBSERVERS) throw SoundPreferencesFailure(SoundPreferencesError.OBSERVER_LIMIT)
        val key = Any()
        val notify = { observer(previewSnapshot(context)) }
        observers[key] = notify
        try { notify() } catch (error: Throwable) { observers.remove(key); throw error }
        return AutoCloseable { synchronized(this) { observers.remove(key) } }
    }
    private fun valid(context: SoundPreferencesContext?) = state.phase == SoundPreferencesPhase.LOCAL_PREVIEW_ONLY &&
        context?.matches(owner, generation, state.scope) == true
    private fun requireContext(context: SoundPreferencesContext?) {
        if (!valid(context)) throw SoundPreferencesFailure(SoundPreferencesError.UNAUTHORISED_UPDATE)
    }
    private fun clear(next: SoundPreferencesState) {
        generation = Any()
        state = next
        publish()
    }
    private fun publish() {
        // A consumer failure cannot undo teardown; use a bounded snapshot for safe unsubscribe.
        observers.values.toList().forEach { runCatching { it() } }
    }
    companion object { const val MAX_OBSERVERS = 64 }
}

/** An org- and generation-fenced preview handle; no media authority is implied. */
class SoundPreferencesSession(private val controller: SoundPreferencesController, private val context: SoundPreferencesContext) {
    val scope: SoundPreferencesScope get() = context.scope
    fun snapshot(): SoundPreferencesState? = controller.previewSnapshot(context)
    fun observe(observer: (SoundPreferencesState?) -> Unit): AutoCloseable = controller.observe(context, observer)
    fun selectPack(pack: SoundPackId) = controller.selectPack(context, pack)
    fun setVolumePercent(value: Int) = controller.setVolumePercent(context, value)
    fun setMuted(value: Boolean) = controller.setMuted(context, value)
    fun setCallDucking(value: Boolean) = controller.setCallDucking(context, value)
    fun leave() = controller.leavePreview(context)
}

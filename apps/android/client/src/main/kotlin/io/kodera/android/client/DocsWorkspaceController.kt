package io.kodera.android.client

import io.kodera.android.domain.DocsPadSummary
import io.kodera.android.domain.DocsWorkspaceError
import io.kodera.android.domain.DocsWorkspaceFailure
import io.kodera.android.domain.DocsWorkspacePhase
import io.kodera.android.domain.DocsWorkspaceScope
import io.kodera.android.domain.DocsWorkspaceState

/** In-process preview fence, not a provider credential or proof of organisation membership. */
class DocsPreviewContext internal constructor(private val owner: Any, private val generation: Any,
    val scope: DocsWorkspaceScope) {
    internal fun matches(owner: Any, generation: Any, scope: DocsWorkspaceScope) =
        this.owner === owner && this.generation === generation && this.scope == scope
}

/** No Docs API or browser integration is provisioned here; callers can only supply local metadata. */
class DocsWorkspaceController(scope: DocsWorkspaceScope) {
    private val owner = Any()
    private var generation = Any()
    private var state = DocsWorkspaceState.unprovisioned(scope)
    private val observers = mutableMapOf<Any, () -> Unit>()

    @Synchronized fun snapshot(): DocsWorkspaceState = state
    @Synchronized fun beginLocalPreview(pads: List<DocsPadSummary>): DocsPreviewContext {
        val next = state.localPreview(pads)
        generation = Any()
        state = next
        val context = DocsPreviewContext(owner, generation, state.scope)
        publish()
        return context
    }
    @Synchronized fun replacePads(context: DocsPreviewContext?, pads: List<DocsPadSummary>) {
        requireContext(context)
        val next = state.replacingPads(pads)
        state = next
        publish()
    }
    @Synchronized fun leave() {
        if (state.phase == DocsWorkspacePhase.STOPPED) return
        clear(DocsWorkspaceState.unprovisioned(state.scope))
    }
    /** Disposal belongs to one preview lifetime and cannot clear a replacement preview. */
    @Synchronized fun leavePreview(context: DocsPreviewContext?) { if (valid(context)) leave() }
    @Synchronized fun stop() = clear(DocsWorkspaceState.stopped(state.scope))
    @Synchronized fun switchScope(scope: DocsWorkspaceScope) {
        if (state.phase == DocsWorkspacePhase.STOPPED) throw DocsWorkspaceFailure(DocsWorkspaceError.STOPPED)
        clear(DocsWorkspaceState.unprovisioned(scope))
    }
    @Synchronized fun previewSnapshot(context: DocsPreviewContext?): DocsWorkspaceState? = if (valid(context)) state else null

    /** Bounded local subscriptions; close releases callbacks captured by a disposed card. */
    @Synchronized fun observe(context: DocsPreviewContext?, observer: (DocsWorkspaceState?) -> Unit): AutoCloseable {
        if (observers.size >= MAX_OBSERVERS) throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PADS)
        val key = Any()
        val notify = { observer(previewSnapshot(context)) }
        observers[key] = notify
        try { notify() } catch (error: Throwable) { observers.remove(key); throw error }
        return AutoCloseable { synchronized(this) { observers.remove(key) } }
    }
    private fun valid(context: DocsPreviewContext?) = state.phase == DocsWorkspacePhase.LOCAL_PREVIEW_ONLY &&
        context?.matches(owner, generation, state.scope) == true
    private fun requireContext(context: DocsPreviewContext?) {
        if (!valid(context)) throw DocsWorkspaceFailure(DocsWorkspaceError.UNAUTHORISED_UPDATE)
    }
    private fun clear(next: DocsWorkspaceState) {
        generation = Any()
        state = next
        publish()
    }
    private fun publish() {
        // UI failure cannot undo a clear; snapshot the bounded collection for safe unsubscribe.
        observers.values.toList().forEach { runCatching { it() } }
    }
    companion object { const val MAX_OBSERVERS = 64 }
}

/** A read-only UI handle that can never follow a replacement scope or preview lifetime. */
class DocsWorkspaceSession(private val controller: DocsWorkspaceController, private val context: DocsPreviewContext) {
    val scope: DocsWorkspaceScope get() = context.scope
    fun snapshot(): DocsWorkspaceState? = controller.previewSnapshot(context)
    fun observe(observer: (DocsWorkspaceState?) -> Unit): AutoCloseable = controller.observe(context, observer)
    fun leave() = controller.leavePreview(context)
}

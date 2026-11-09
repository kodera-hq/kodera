package io.kodera.android.client

import io.kodera.android.domain.VoiceCallError
import io.kodera.android.domain.VoiceCallFailure
import io.kodera.android.domain.VoiceCallParticipant
import io.kodera.android.domain.VoiceCallPhase
import io.kodera.android.domain.VoiceCallScope
import io.kodera.android.domain.VoiceCallState

/** Opaque local capability, not provider authentication, membership or a media connection. */
class VoiceCallPreviewContext internal constructor(private val owner: Any, private val generation: Any,
    val scope: VoiceCallScope) {
    internal fun matches(owner: Any, generation: Any, scope: VoiceCallScope) =
        this.owner === owner && this.generation === generation && this.scope == scope
}

/**
 * In-memory local preview only. No transport adapter, capture or remote-media state is implemented.
 * An eventual authenticated adapter must verify membership before issuing its own media capability;
 * an ordinary Core session and this preview capability cannot substitute for that verification.
 */
class VoiceCallController(scope: VoiceCallScope) {
    private val owner = Any()
    private var generation = Any()
    private var state = VoiceCallState.unprovisioned(scope)
    private val observers = mutableMapOf<Any, () -> Unit>()

    @Synchronized fun snapshot(): VoiceCallState = state

    @Synchronized fun beginLocalPreview(participants: List<VoiceCallParticipant>): VoiceCallPreviewContext {
        val next = state.localPreview(participants)
        generation = Any()
        state = next
        val context = VoiceCallPreviewContext(owner, generation, state.scope)
        publish()
        return context
    }
    @Synchronized fun replaceParticipants(context: VoiceCallPreviewContext?, participants: List<VoiceCallParticipant>) {
        requireContext(context)
        val next = state.replacingParticipants(participants)
        state = next
        publish()
    }
    @Synchronized fun setMuted(context: VoiceCallPreviewContext?, value: Boolean) {
        requireContext(context)
        state = state.muted(value)
        publish()
    }
    @Synchronized fun setDeafened(context: VoiceCallPreviewContext?, value: Boolean) {
        requireContext(context)
        state = state.deafened(value)
        publish()
    }
    @Synchronized fun leave() {
        if (state.phase == VoiceCallPhase.STOPPED) return
        clear(VoiceCallState.unprovisioned(state.scope))
    }
    /** A disposed old card must not clear a replacement preview. */
    @Synchronized fun leavePreview(context: VoiceCallPreviewContext?) {
        if (valid(context)) leave()
    }
    @Synchronized fun stop() = clear(VoiceCallState.stopped(state.scope))
    @Synchronized fun switchScope(scope: VoiceCallScope) {
        if (state.phase == VoiceCallPhase.STOPPED) throw VoiceCallFailure(VoiceCallError.STOPPED)
        clear(VoiceCallState.unprovisioned(scope))
    }
    @Synchronized fun previewSnapshot(context: VoiceCallPreviewContext?): VoiceCallState? =
        if (valid(context)) state else null

    /** At most 64 local observers; closing removes the callback and its captured UI state. */
    @Synchronized fun observe(context: VoiceCallPreviewContext?, observer: (VoiceCallState?) -> Unit): AutoCloseable {
        if (observers.size >= VoiceCallState.MAX_PARTICIPANTS) throw VoiceCallFailure(VoiceCallError.INVALID_ROSTER)
        val key = Any()
        val notify = { observer(previewSnapshot(context)) }
        observers[key] = notify
        try { notify() } catch (error: Throwable) { observers.remove(key); throw error }
        return AutoCloseable { synchronized(this) { observers.remove(key) } }
    }
    private fun valid(context: VoiceCallPreviewContext?) = state.phase == VoiceCallPhase.LOCAL_PREVIEW_ONLY &&
        context?.matches(owner, generation, state.scope) == true
    private fun requireContext(context: VoiceCallPreviewContext?) {
        if (!valid(context)) throw VoiceCallFailure(VoiceCallError.UNAUTHORISED_UPDATE)
    }
    private fun clear(next: VoiceCallState) {
        generation = Any()
        state = next
        publish()
    }
    private fun publish() {
        // Notifications are local, synchronous and serialized with mutations. UI failure cannot undo
        // a security clear; copy the bounded collection so a callback can remove its subscription.
        observers.values.toList().forEach { runCatching { it() } }
    }
}

/** A UI handle is fenced to the exact preview lifetime; it can never follow a replacement call. */
class VoiceCallDockSession(private val controller: VoiceCallController, private val context: VoiceCallPreviewContext) {
    val scope: VoiceCallScope get() = context.scope
    fun snapshot(): VoiceCallState? = controller.previewSnapshot(context)
    fun observe(observer: (VoiceCallState?) -> Unit): AutoCloseable = controller.observe(context, observer)
    fun setMuted(value: Boolean) = controller.setMuted(context, value)
    fun setDeafened(value: Boolean) = controller.setDeafened(context, value)
    fun leave() = controller.leavePreview(context)
}

package io.kodera.android.client

import io.kodera.android.domain.*

/** Correlation/lifetime fence only; a locally supplied rank never establishes service authority. */
data class WorkspacePreferencesScope(val organisationId: String, val channelId: String) {
    init {
        ChannelPollScope(organisationId, channelId)
    }
}

class WorkspacePreferencesContext internal constructor(private val owner: Any, private val generation: Any,
    val scope: WorkspacePreferencesScope) {
    internal fun matches(owner: Any, generation: Any, scope: WorkspacePreferencesScope) =
        this.owner === owner && this.generation === generation && this.scope == scope
}

enum class WorkspacePreferencesPhase { UNPROVISIONED, LOCAL_PREVIEW_ONLY, STOPPED }
data class WorkspacePreferencesSnapshot(val scope: WorkspacePreferencesScope, val phase: WorkspacePreferencesPhase,
    val themeMode: KoderaThemeMode, val activeThemeSpec: ShareableThemeSpec, val shareCode: String,
    val profile: KoderaUserProfile?, val activeDocsPad: DocsPadDraft?, val lastError: String?)

/** In-memory local preferences, profile/IAM simulation and Markdown draft; no service/persistence. */
class WorkspacePreferencesController(scope: WorkspacePreferencesScope) {
    private val owner = Any()
    private var generation = Any()
    private var state = empty(scope, WorkspacePreferencesPhase.UNPROVISIONED)
    private val observers = mutableMapOf<Any, () -> Unit>()

    @Synchronized fun snapshot(): WorkspacePreferencesSnapshot = state
    @Synchronized fun beginLocalPreview(profile: KoderaUserProfile, document: DocsPadDraft): WorkspacePreferencesContext {
        if (state.phase == WorkspacePreferencesPhase.STOPPED) refuse(WorkspacePreferencesError.STOPPED)
        if (document.channelId != state.scope.channelId || document.updatedBy != profile.userId) refuse(WorkspacePreferencesError.INVALID_DOCUMENT)
        generation = Any()
        state = state.copy(phase = WorkspacePreferencesPhase.LOCAL_PREVIEW_ONLY, profile = profile, activeDocsPad = document, lastError = null)
        val context = WorkspacePreferencesContext(owner, generation, state.scope)
        publish()
        return context
    }
    @Synchronized fun selectThemeMode(context: WorkspacePreferencesContext?, mode: KoderaThemeMode) = mutate(context) {
        // Selecting a core mode restores its curated palette; imports remain explicit custom previews.
        val theme = ShareableThemeCodec.CURATED_PRESETS.first { it.baseMode == mode }
        state.copy(themeMode = mode, activeThemeSpec = theme, shareCode = ShareableThemeCodec.encode(theme), lastError = null)
    }
    @Synchronized fun applyPreset(context: WorkspacePreferencesContext?, id: String) = mutate(context) {
        val theme = ShareableThemeCodec.CURATED_PRESETS.firstOrNull { it.id == id } ?: refuse(WorkspacePreferencesError.INVALID_THEME)
        state.copy(themeMode = theme.baseMode, activeThemeSpec = theme, shareCode = ShareableThemeCodec.encode(theme), lastError = null)
    }
    @Synchronized fun importShareCode(context: WorkspacePreferencesContext?, code: String) = mutate(context) {
        val theme = ShareableThemeCodec.decode(code)
        state.copy(themeMode = theme.baseMode, activeThemeSpec = theme, shareCode = ShareableThemeCodec.encode(theme), lastError = null)
    }
    @Synchronized fun updateProfile(context: WorkspacePreferencesContext?, displayName: String, handle: String,
        roleTitle: String, presence: KoderaPresenceStatus, rank: KoderaRoleRank) = mutate(context) {
        val current = state.profile ?: refuse(WorkspacePreferencesError.UNPROVISIONED)
        state.copy(profile = current.copy(displayName = displayName, handle = handle, roleTitle = roleTitle, presence = presence, rank = rank), lastError = null)
    }
    @Synchronized fun updateDocsPad(context: WorkspacePreferencesContext?, title: String, markdownBody: String) = mutate(context) {
        val current = state.activeDocsPad ?: refuse(WorkspacePreferencesError.UNPROVISIONED)
        val actor = state.profile?.userId ?: refuse(WorkspacePreferencesError.UNPROVISIONED)
        state.copy(activeDocsPad = current.updateContent(title, markdownBody, actor), lastError = null)
    }
    @Synchronized fun evaluateAccess(context: WorkspacePreferencesContext?, policy: ChannelIamPolicy): ChannelIamDecision {
        requireContext(context)
        if (policy.channelId != state.scope.channelId) refuse(WorkspacePreferencesError.INVALID_POLICY)
        return policy.evaluate(state.profile?.rank ?: refuse(WorkspacePreferencesError.UNPROVISIONED))
    }
    @Synchronized fun leave() {
        if (state.phase != WorkspacePreferencesPhase.STOPPED) clear(state.scope, WorkspacePreferencesPhase.UNPROVISIONED)
    }
    @Synchronized fun leavePreview(context: WorkspacePreferencesContext?) { if (valid(context)) leave() }
    @Synchronized fun switchScope(scope: WorkspacePreferencesScope) {
        if (state.phase == WorkspacePreferencesPhase.STOPPED) refuse(WorkspacePreferencesError.STOPPED)
        clear(scope, WorkspacePreferencesPhase.UNPROVISIONED)
    }
    @Synchronized fun stop() = clear(state.scope, WorkspacePreferencesPhase.STOPPED)
    @Synchronized fun previewSnapshot(context: WorkspacePreferencesContext?): WorkspacePreferencesSnapshot? = if (valid(context)) state else null
    @Synchronized fun observe(context: WorkspacePreferencesContext?, observer: (WorkspacePreferencesSnapshot?) -> Unit): AutoCloseable {
        if (observers.size >= MAX_OBSERVERS) refuse(WorkspacePreferencesError.OBSERVER_LIMIT)
        val key = Any()
        val notify = { observer(previewSnapshot(context)) }
        observers[key] = notify
        try { notify() } catch (error: Throwable) { observers.remove(key); throw error }
        return AutoCloseable { synchronized(this) { observers.remove(key) } }
    }
    private fun mutate(context: WorkspacePreferencesContext?, update: () -> WorkspacePreferencesSnapshot) {
        requireContext(context)
        try { state = update() } catch (error: WorkspacePreferencesFailure) {
            state = state.copy(lastError = error.reason.name)
            publish()
            throw error
        }
        publish()
    }
    private fun valid(context: WorkspacePreferencesContext?) = state.phase == WorkspacePreferencesPhase.LOCAL_PREVIEW_ONLY &&
        context?.matches(owner, generation, state.scope) == true
    private fun requireContext(context: WorkspacePreferencesContext?) {
        if (!valid(context)) refuse(WorkspacePreferencesError.STALE_CONTEXT)
    }
    private fun clear(scope: WorkspacePreferencesScope, phase: WorkspacePreferencesPhase) {
        generation = Any()
        state = empty(scope, phase)
        publish()
    }
    private fun publish() { observers.values.toList().forEach { runCatching { it() } } }
    private fun refuse(reason: WorkspacePreferencesError): Nothing = throw WorkspacePreferencesFailure(reason)
    companion object {
        const val MAX_OBSERVERS = 64
        private fun empty(scope: WorkspacePreferencesScope, phase: WorkspacePreferencesPhase): WorkspacePreferencesSnapshot {
            val theme = ShareableThemeCodec.CURATED_PRESETS.first()
            return WorkspacePreferencesSnapshot(scope, phase, KoderaThemeMode.BLACK, theme, ShareableThemeCodec.encode(theme), null, null, null)
        }
    }
}

/** Captured UI handle; stale disposal cannot erase a newer preview of the same channel. */
class WorkspacePreferencesSession(private val controller: WorkspacePreferencesController, private val context: WorkspacePreferencesContext) {
    val scope: WorkspacePreferencesScope get() = context.scope
    fun snapshot() = controller.previewSnapshot(context)
    fun observe(observer: (WorkspacePreferencesSnapshot?) -> Unit) = controller.observe(context, observer)
    fun selectThemeMode(mode: KoderaThemeMode) = controller.selectThemeMode(context, mode)
    fun applyPreset(id: String) = controller.applyPreset(context, id)
    fun importShareCode(code: String) = controller.importShareCode(context, code)
    fun updateProfile(displayName: String, handle: String, roleTitle: String, presence: KoderaPresenceStatus, rank: KoderaRoleRank) =
        controller.updateProfile(context, displayName, handle, roleTitle, presence, rank)
    fun updateDocsPad(title: String, markdownBody: String) = controller.updateDocsPad(context, title, markdownBody)
    fun evaluateAccess(policy: ChannelIamPolicy) = controller.evaluateAccess(context, policy)
    fun leave() = controller.leavePreview(context)
}

package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

class WorkspacePreferencesControllerTests {
    private val org = "11111111-1111-4111-8111-111111111111"
    private val actor = "22222222-2222-4222-8222-222222222222"
    private val scope = WorkspacePreferencesScope(org, "channel")
    private fun profile() = KoderaUserProfile(actor, "Local member", "local.member", "Member", KoderaPresenceStatus.OFFLINE, KoderaRoleRank.MEMBER)
    private fun document(channel: String = "channel") = DocsPadDraft("pad", channel, "Local draft", "# Local Markdown", 1, actor)
    private fun preview(controller: WorkspacePreferencesController) = controller.beginLocalPreview(profile(), document())
    private fun refuses(reason: WorkspacePreferencesError, action: () -> Unit) {
        try { action(); fail("expected refusal") } catch (error: WorkspacePreferencesFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun unprovisionedDefaultsNeverInventProfileDocumentOrAuthority() {
        val controller = WorkspacePreferencesController(scope)
        val state = controller.snapshot()
        assertEquals(WorkspacePreferencesPhase.UNPROVISIONED, state.phase)
        assertEquals(KoderaThemeMode.BLACK, state.themeMode)
        assertNull(state.profile)
        assertNull(state.activeDocsPad)
        assertNull(controller.previewSnapshot(null))
        refuses(WorkspacePreferencesError.STALE_CONTEXT) { controller.selectThemeMode(null, KoderaThemeMode.LIGHT) }
        assertEquals(state, controller.snapshot())
    }
    @Test fun themeModePresetAndStrictImportMaintainCanonicalShareCode() {
        val controller = WorkspacePreferencesController(scope)
        val context = preview(controller)
        controller.selectThemeMode(context, KoderaThemeMode.DARK)
        assertEquals(KoderaThemeMode.DARK, ShareableThemeCodec.decode(controller.snapshot().shareCode).baseMode)
        assertEquals("rgb(8, 16, 12)", controller.snapshot().activeThemeSpec.tokens.page)
        controller.applyPreset(context, "preset-cobalt-polaire")
        assertEquals(KoderaThemeMode.LIGHT, controller.snapshot().themeMode)
        val custom = ShareableThemeCodec.CURATED_PRESETS.last().copy(id = "custom", name = "Local custom")
        controller.importShareCode(context, ShareableThemeCodec.encode(custom))
        assertEquals(custom, controller.snapshot().activeThemeSpec)
        assertEquals(ShareableThemeCodec.encode(custom), controller.snapshot().shareCode)
        controller.selectThemeMode(context, KoderaThemeMode.LIGHT)
        assertEquals("preset-cobalt-polaire", controller.snapshot().activeThemeSpec.id)
        assertEquals("rgb(255, 255, 255)", controller.snapshot().activeThemeSpec.tokens.page)
        assertEquals(controller.snapshot().activeThemeSpec, ShareableThemeCodec.decode(controller.snapshot().shareCode))
    }
    @Test fun failedImportsAndProfileOrDocumentValidationPreservePayloadAndHideRawErrors() {
        val controller = WorkspacePreferencesController(scope)
        val context = preview(controller)
        val original = controller.snapshot()
        val raw = "private-looking-import"
        refuses(WorkspacePreferencesError.INVALID_THEME) { controller.importShareCode(context, raw) }
        assertEquals(original.copy(lastError = WorkspacePreferencesError.INVALID_THEME.name), controller.snapshot())
        assertFalse(controller.snapshot().lastError!!.contains(raw))
        refuses(WorkspacePreferencesError.INVALID_PROFILE) { controller.updateProfile(context, "", "handle", "Role", KoderaPresenceStatus.ONLINE, KoderaRoleRank.OWNER) }
        assertEquals(original.profile, controller.snapshot().profile)
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { controller.updateDocsPad(context, "Title", "a".repeat(65537)) }
        assertEquals(original.activeDocsPad, controller.snapshot().activeDocsPad)
        controller.selectThemeMode(context, KoderaThemeMode.BLACK)
        assertNull(controller.snapshot().lastError)
    }
    @Test fun profileEditingIsOnlyLocalRankSimulationAndDocsActorRemainsBound() {
        val controller = WorkspacePreferencesController(scope)
        val context = preview(controller)
        controller.updateProfile(context, "Edited local member", "edited", "Local role", KoderaPresenceStatus.DND, KoderaRoleRank.OWNER)
        val policy = ChannelIamPolicy(scope.channelId, "category", true, KoderaRoleRank.MEMBER, KoderaRoleRank.MODERATOR, KoderaRoleRank.ADMIN, true, true)
        assertTrue(controller.evaluateAccess(context, policy).canManage)
        controller.updateDocsPad(context, "Edited title", "**Literal local Markdown**")
        assertEquals(actor, controller.snapshot().profile!!.userId)
        assertEquals(actor, controller.snapshot().activeDocsPad!!.updatedBy)
        assertEquals(2, controller.snapshot().activeDocsPad!!.revision)
        controller.updateProfile(context, "Name", "handle", "Role", KoderaPresenceStatus.IDLE, KoderaRoleRank.GUEST)
        assertFalse(controller.evaluateAccess(context, policy).canRead)
        refuses(WorkspacePreferencesError.INVALID_POLICY) { controller.evaluateAccess(context, policy.copy(channelId = "other")) }
    }
    @Test fun invalidProvisioningDoesNotReplaceTheExistingContextOrPayload() {
        val controller = WorkspacePreferencesController(scope)
        val context = preview(controller)
        val original = controller.snapshot()
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { controller.beginLocalPreview(profile(), document("other")) }
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { controller.beginLocalPreview(profile(), document().copy(updatedBy = org)) }
        assertEquals(original, controller.snapshot())
        controller.selectThemeMode(context, KoderaThemeMode.LIGHT)
    }
    @Test fun nilForeignAndSameScopeReplacementHandlesCannotMutateOrDisposeNewPreview() {
        val controller = WorkspacePreferencesController(scope)
        val old = preview(controller)
        val foreign = preview(WorkspacePreferencesController(scope))
        val current = preview(controller)
        for (context in listOf(null, old, foreign)) {
            refuses(WorkspacePreferencesError.STALE_CONTEXT) { controller.selectThemeMode(context, KoderaThemeMode.LIGHT) }
            refuses(WorkspacePreferencesError.STALE_CONTEXT) { controller.updateDocsPad(context, "bad", "bad") }
            controller.leavePreview(context)
        }
        assertNotNull(controller.previewSnapshot(current))
        assertNull(controller.previewSnapshot(old))
        controller.leavePreview(current)
        assertNull(controller.snapshot().profile)
        assertNull(controller.snapshot().activeDocsPad)
    }
    @Test fun awayAndBackScopeResetInvalidatesEverythingAndStopIsTerminal() {
        val controller = WorkspacePreferencesController(scope)
        val old = preview(controller)
        controller.switchScope(WorkspacePreferencesScope(org, "other"))
        controller.switchScope(scope)
        assertNull(controller.previewSnapshot(old))
        assertEquals(WorkspacePreferencesPhase.UNPROVISIONED, controller.snapshot().phase)
        val current = preview(controller)
        controller.stop()
        controller.leave()
        assertEquals(WorkspacePreferencesPhase.STOPPED, controller.snapshot().phase)
        assertNull(controller.snapshot().profile)
        assertNull(controller.snapshot().activeDocsPad)
        assertNull(controller.previewSnapshot(current))
        refuses(WorkspacePreferencesError.STOPPED) { preview(controller) }
        refuses(WorkspacePreferencesError.STOPPED) { controller.switchScope(scope) }
    }
    @Test fun sessionsAndObserversReleaseAndObsoleteDisposalDoesNotEraseReplacement() {
        val controller = WorkspacePreferencesController(scope)
        val old = WorkspacePreferencesSession(controller, preview(controller))
        var last: WorkspacePreferencesSnapshot? = null
        val subscription = old.observe { last = it }
        assertNotNull(last)
        val current = WorkspacePreferencesSession(controller, preview(controller))
        assertNull(last)
        old.leave()
        assertNotNull(current.snapshot())
        subscription.close()
        current.leave()
        assertNull(current.snapshot())
    }
    @Test fun observerCapacityAndFailedInitialRegistrationAreBounded() {
        val controller = WorkspacePreferencesController(scope)
        val context = preview(controller)
        try { controller.observe(context) { error("local consumer failure") }; fail("expected consumer failure") } catch (_: IllegalStateException) { }
        val subscriptions = (1..WorkspacePreferencesController.MAX_OBSERVERS).map { controller.observe(context) {} }
        refuses(WorkspacePreferencesError.OBSERVER_LIMIT) { controller.observe(context) {} }
        subscriptions.forEach { it.close() }
        controller.observe(context) {}.close()
        assertNotNull(controller.previewSnapshot(context))
    }
}

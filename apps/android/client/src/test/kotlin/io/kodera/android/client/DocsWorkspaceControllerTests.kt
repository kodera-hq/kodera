package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

class DocsWorkspaceControllerTests {
    private val scope = DocsWorkspaceScope("11111111-1111-4111-8111-111111111111", "text-one")
    private val other = DocsWorkspaceScope("22222222-2222-4222-8222-222222222222", "text-one")
    private fun pads(scope: DocsWorkspaceScope = this.scope, id: String = "pad-one") =
        listOf(DocsPadSummary(scope, id, "Document", "https://docs.example.org/docs/one", 0))
    private fun refuses(reason: DocsWorkspaceError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: DocsWorkspaceFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun defaultIsUnprovisionedAndExplicitPreviewOnlyExposesReadOnlyMetadata() {
        val controller = DocsWorkspaceController(scope)
        assertEquals(DocsWorkspacePhase.UNPROVISIONED, controller.snapshot().phase)
        assertTrue(controller.snapshot().pads.isEmpty())
        assertNull(controller.previewSnapshot(null))
        val context = controller.beginLocalPreview(pads())
        val session = DocsWorkspaceSession(controller, context)
        assertEquals(scope, session.scope)
        assertEquals(DocsWorkspacePhase.LOCAL_PREVIEW_ONLY, session.snapshot()!!.phase)
        assertEquals("pad-one", session.snapshot()!!.pads.single().id)
        controller.replacePads(context, pads(id = "updated"))
        assertEquals("updated", session.snapshot()!!.pads.single().id)
    }
    @Test fun nilForeignAndCrossScopeUpdatesAreRefusedTransactionally() {
        val controller = DocsWorkspaceController(scope)
        val context = controller.beginLocalPreview(pads())
        val before = controller.snapshot()
        val foreign = DocsWorkspaceController(scope).beginLocalPreview(pads())
        for (bad in listOf(null, foreign)) {
            refuses(DocsWorkspaceError.UNAUTHORISED_UPDATE) { controller.replacePads(bad, pads(id = "wrong")) }
            assertSame(before, controller.snapshot())
        }
        refuses(DocsWorkspaceError.INVALID_PADS) { controller.replacePads(context, pads(other)) }
        assertSame(before, controller.snapshot())
    }
    @Test fun invalidPreviewAndReplacementPreserveTheWorkingGenerationAndState() {
        val controller = DocsWorkspaceController(scope)
        val context = controller.beginLocalPreview(pads())
        val before = controller.snapshot()
        for (invalid in listOf(emptyList(), pads(other), pads() + pads(), (1..33).map { pads(id = it.toString()).single() })) {
            refuses(DocsWorkspaceError.INVALID_PADS) { controller.beginLocalPreview(invalid) }
            assertSame(before, controller.previewSnapshot(context))
            refuses(DocsWorkspaceError.INVALID_PADS) { controller.replacePads(context, invalid) }
            assertSame(before, controller.snapshot())
        }
    }
    @Test fun allClearsFenceLateCallbacksIncludingSwitchAwayAndBackToSameScope() {
        for (action in listOf<(DocsWorkspaceController) -> Unit>({ it.leave() }, { it.stop() }, {
            it.switchScope(other); it.switchScope(scope)
        }, { it.switchScope(scope) })) {
            val controller = DocsWorkspaceController(scope)
            val context = controller.beginLocalPreview(pads())
            action(controller)
            assertTrue(controller.snapshot().pads.isEmpty())
            assertNull(controller.previewSnapshot(context))
            refuses(DocsWorkspaceError.UNAUTHORISED_UPDATE) { controller.replacePads(context, pads(id = "late")) }
            assertTrue(controller.snapshot().pads.isEmpty())
        }
    }
    @Test fun replacementPreviewMakesOldHandleAndDisposalHarmless() {
        val controller = DocsWorkspaceController(scope)
        val oldContext = controller.beginLocalPreview(pads())
        val old = DocsWorkspaceSession(controller, oldContext)
        val current = DocsWorkspaceSession(controller, controller.beginLocalPreview(pads(id = "new")))
        old.leave()
        assertNull(old.snapshot())
        assertEquals("new", current.snapshot()!!.pads.single().id)
        refuses(DocsWorkspaceError.UNAUTHORISED_UPDATE) { controller.replacePads(oldContext, pads()) }
        current.leave()
        assertTrue(controller.snapshot().pads.isEmpty())
    }
    @Test fun stopIsTerminalAndRepeatedClearsNeverRestorePads() {
        val controller = DocsWorkspaceController(scope)
        controller.beginLocalPreview(pads()); controller.stop(); controller.leave(); controller.stop()
        assertEquals(DocsWorkspacePhase.STOPPED, controller.snapshot().phase)
        assertTrue(controller.snapshot().pads.isEmpty())
        refuses(DocsWorkspaceError.STOPPED) { controller.beginLocalPreview(pads()) }
        refuses(DocsWorkspaceError.STOPPED) { controller.switchScope(other) }
    }
    @Test fun observerInvalidationClearsUiAndUnsubscribeReleasesCallback() {
        val controller = DocsWorkspaceController(scope)
        val context = controller.beginLocalPreview(pads())
        val observed = mutableListOf<DocsWorkspaceState?>()
        val subscription = controller.observe(context) { observed.add(it) }
        assertNotNull(observed.last())
        controller.replacePads(context, pads(id = "next"))
        assertEquals("next", observed.last()!!.pads.single().id)
        controller.switchScope(other)
        assertNull(observed.last())
        subscription.close()
        val count = observed.size
        controller.switchScope(scope); controller.beginLocalPreview(pads())
        assertEquals(count, observed.size)
    }
    @Test fun observerBoundsAndFailedInitialCallbackDoNotLeakSlots() {
        val controller = DocsWorkspaceController(scope)
        val context = controller.beginLocalPreview(pads())
        repeat(65) {
            try { controller.observe(context) { error("consumer failed") }; fail("expected callback failure") }
            catch (_: IllegalStateException) { }
        }
        val subscriptions = (1..64).map { controller.observe(context) {} }
        refuses(DocsWorkspaceError.INVALID_PADS) { controller.observe(context) {} }
        subscriptions.forEach { it.close(); it.close() }
        controller.observe(context) {}.close()
    }
}

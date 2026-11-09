package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

class DocsWorkspaceStateTests {
    private val scope = DocsWorkspaceScope("11111111-1111-4111-8111-111111111111", "text-one")
    private fun pad(id: String = "pad-one", time: Long = 1, url: String = "https://docs.example.org/docs/pad-one",
        scope: DocsWorkspaceScope = this.scope, title: String = "Project document") = DocsPadSummary(scope, id, title, url, time)
    private fun refuses(reason: DocsWorkspaceError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: DocsWorkspaceFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun scopeRequiresCanonicalOrganisationAndBoundedNonblankChannel() {
        for (org in listOf("", "org", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", " " + scope.organisationId)) {
            refuses(DocsWorkspaceError.INVALID_SCOPE) { DocsWorkspaceScope(org, "text") }
        }
        for (channel in listOf("", " ", " text", "text\n", "a".repeat(257))) {
            refuses(DocsWorkspaceError.INVALID_SCOPE) { DocsWorkspaceScope(scope.organisationId, channel) }
        }
        assertEquals(256, DocsWorkspaceScope(scope.organisationId, "a".repeat(256)).channelId.length)
    }
    @Test fun padMetadataBoundsAndNonnegativeTimestampAreValidated() {
        for (id in listOf("", "bad id", "a\n", "a".repeat(129), "é")) {
            refuses(DocsWorkspaceError.INVALID_PAD) { pad(id = id) }
        }
        for (title in listOf("", " ", " title", "title ", "title\n", "a".repeat(257))) {
            refuses(DocsWorkspaceError.INVALID_PAD) { pad(title = title) }
        }
        refuses(DocsWorkspaceError.INVALID_PAD) { pad(time = -1) }
        assertEquals(128, pad(id = "a".repeat(128), title = "À l’abri", time = Long.MAX_VALUE).id.length)
        assertEquals(256, pad(title = "a".repeat(256), time = 0).title.length)
    }
    @Test fun urlsAdmitCanonicalPublicHttpsAndOnlyTheExactDefaultPort() {
        for (url in listOf("https://docs.example.org/docs/plan-1", "https://docs.example.org:443/pads/plan_2")) {
            val valid = pad(url = url)
            assertEquals(url, valid.httpsUrl)
            assertEquals("docs.example.org", valid.host)
            assertTrue(valid.path.startsWith('/'))
        }
    }
    @Test fun urlsRefuseUserinfoQueriesFragmentsPortsAndUntrustedHosts() {
        for (url in listOf(
            "http://docs.example.org/docs/one", "HTTPS://docs.example.org/docs/one",
            "https://DOCS.example.org/docs/one", "https://docs.example.org./docs/one",
            "https://user:pass@docs.example.org/docs/one", "https://@docs.example.org/docs/one",
            "https://docs.example.org/docs/one?", "https://docs.example.org/docs/one?token=untrusted",
            "https://docs.example.org/docs/one#", "https://docs.example.org/docs/one#part",
            "https://docs.example.org:444/docs/one", "https://docs.example.org:0443/docs/one",
            "https://docs.example.org:/docs/one", "https://docs.example.org:0/docs/one",
            "https://localhost/docs/one", "https://docs.localhost/docs/one",
            "https://docs.local/docs/one", "https://docs.internal/docs/one",
            "https://docs.x/docs/one", "https://docs.123/docs/one", "https://docs.c0m/docs/one",
            "https://127.0.0.1/docs/one", "https://169.254.169.254/docs/one", "https://10.0.0.1/docs/one",
            "https://0x7f.0.0.1/docs/one", "https://2130706433/docs/one", "https://[::1]/docs/one",
            "https://[fe80::1]/docs/one", "https://[::ffff:127.0.0.1]/docs/one",
            "https://docs.example.org@localhost/docs/one", "https://döcs.example.org/docs/one",
        )) refuses(DocsWorkspaceError.INVALID_URL) { pad(url = url) }
    }
    @Test fun rawAndEncodedPathNormalizationCannotBypassUrlAdmission() {
        for (url in listOf(
            "https://docs.example.org", "https://docs.example.org/", "https://docs.example.org//docs/one",
            "https://docs.example.org/docs//one", "https://docs.example.org/docs/../one",
            "https://docs.example.org/docs/./one", "https://docs.example.org/docs/..",
            "https://docs.example.org/pads/..;/secret", "https://docs.example.org/pads/one;session=two",
            "https://docs.example.org/pads/one:two", "https://docs.example.org/pads/one@two",
            "https://docs.example.org/docs/%2e%2e/one", "https://docs.example.org/docs/%252e%252e/one",
            "https://docs.example.org/docs%2fone", "https://docs.example.org/docs/%5cone",
            "https://docs.example.org/docs\\one", "https://docs.example.org/docs/one ",
            " https://docs.example.org/docs/one", "https://docs.example.org/docs/one\n",
            "https://docs.example.org/docs/" + "a".repeat(2048),
        )) refuses(DocsWorkspaceError.INVALID_URL) { pad(url = url) }
    }
    @Test fun padListsAreBoundedScopedUniqueSortedAndDefensivelyOwned() {
        val source = mutableListOf(pad("z", 5), pad("b", Long.MAX_VALUE), pad("a", Long.MAX_VALUE), pad("old", 0))
        val state = DocsWorkspaceState.unprovisioned(scope).localPreview(source)
        source.clear()
        assertEquals(listOf("a", "b", "z", "old"), state.pads.map { it.id })
        try { (state.pads as MutableList).clear(); fail("mutable pads") } catch (_: UnsupportedOperationException) { }
        val full = (1..32).map { pad(it.toString()) }
        assertEquals(32, state.replacingPads(full).pads.size)
        for (invalid in listOf(emptyList(), full + pad("extra"), listOf(pad(), pad()),
            listOf(pad(scope = scope.copy(channelId = "other"))),
            listOf(pad(scope = scope.copy(organisationId = "22222222-2222-4222-8222-222222222222"))))) {
            refuses(DocsWorkspaceError.INVALID_PADS) { state.replacingPads(invalid) }
        }
        val huge = object : AbstractList<DocsPadSummary>() {
            override val size: Int = Int.MAX_VALUE
            override fun get(index: Int): DocsPadSummary = error("must check size before traversal")
        }
        refuses(DocsWorkspaceError.INVALID_PADS) { state.replacingPads(huge) }
    }
    @Test fun unprovisionedAndStoppedStatesHaveNoPadsAndStopIsTerminal() {
        val empty = DocsWorkspaceState.unprovisioned(scope)
        assertEquals(DocsWorkspacePhase.UNPROVISIONED, empty.phase)
        assertTrue(empty.pads.isEmpty())
        refuses(DocsWorkspaceError.NOT_PREVIEWING) { empty.replacingPads(listOf(pad())) }
        val stopped = DocsWorkspaceState.stopped(scope)
        assertTrue(stopped.pads.isEmpty())
        refuses(DocsWorkspaceError.STOPPED) { stopped.localPreview(listOf(pad())) }
    }
}

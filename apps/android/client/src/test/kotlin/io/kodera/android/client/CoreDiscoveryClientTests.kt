package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test

class CoreDiscoveryClientTests {
    @Test fun testExactAnonymousSlugRequest() {
        WireFixture().use { wire -> wire.client().use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
            val request = wire.requests.single(); assertEquals("POST", request.method); assertEquals("/api/v1/auth/discover", request.target)
            assertEquals("core.test", request.headers["host"]); assertEquals("application/json", request.headers["content-type"])
            assertEquals("no-store", request.headers["cache-control"]); assertEquals("identity", request.headers["accept-encoding"])
            assertEquals("""{"slug":"atelier"}""", request.body.toString(Charsets.UTF_8)); assertAnonymous(request)
            assertTrue(request.headers["idempotency-key"]?.matches(Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) == true)
            assertEquals(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), result.await())
        } }
    }
    @Test fun testCanonicalSlugPreservedAndInvalidInputStartsNoCall() {
        WireFixture().use { wire -> wire.client().use { client ->
            for (slug in listOf("UPPER", "four", "a".repeat(21), " atelier", "atelier/", "-team", "team-", "équipe")) {
                val result = OutcomeProbe(); client.discover(slug, result::receive)
                assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.InvalidInput), result.await())
            }
            assertEquals(0, wire.requests.size)
            val result = OutcomeProbe(); client.discover("1team", result::receive); wire.awaitRequests()
            assertEquals("""{"slug":"1team"}""", wire.requests.single().body.toString(Charsets.UTF_8)); result.await()
        } }
    }
    @Test fun testMissingConfigurationStartsNoCall() {
        CoreDiscoveryClient(null).use { client -> val result = OutcomeProbe(); client.discover("atelier", result::receive)
            assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.NotConfigured), result.await()) }
    }
    @Test fun testUntrustedOriginProfilesRefusedBeforeUrlConstruction() {
        for (origin in listOf("http://core.test", "https://core.test/", "https://core.test:443", "https://core.test:8443", "https://user@core.test", "https://core.test/path", "https://%63ore.test", "https://0x7f.0x0.0x0.0x1")) {
            var rejected = false
            try { CoreDiscoveryConfiguration.configured(origin, setOf("https://id.kodera.io")) } catch (_: IllegalArgumentException) { rejected = true } catch (_: io.kodera.android.domain.DomainFailure) { rejected = true }
            assertTrue("Untrusted raw origin must be refused", rejected)
        }
        var rejected = false; try { CoreDiscoveryConfiguration.configured("https://core.test", emptySet()) } catch (_: Exception) { rejected = true }
        assertTrue(rejected)
    }
    @Test fun testUnexpectedStatusAndHtmlCannotBecomeNoMatch() {
        for (status in listOf(204, 404, 502)) WireFixture(reply = { WireReply(status, "<html>not JSON</html>".toByteArray(), listOf("Content-Type" to "text/html")) }).use { wire -> wire.client().use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
            assertTrue("Unexpected service response remains unavailable", result.await() is AnonymousDiscoveryOutcome.Failure)
        } }
    }
    @Test fun testSingleMatchesQueryAndMultipleRemainsExplicitChoice() {
        WireFixture(reply = { if (it.body.toString(Charsets.UTF_8).contains("bureau")) WireReply(body = Fixtures.data()) else WireReply(body = Fixtures.data("many")) }).use { wire -> wire.client().use { client ->
            val wrong = OutcomeProbe(); client.discover("bureau", wrong::receive); wire.awaitRequests()
            assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), wrong.await())
            val many = OutcomeProbe(); client.discover("atelier", many::receive); wire.awaitRequests(2)
            val outcome = many.await(); assertTrue(outcome is AnonymousDiscoveryOutcome.Result)
            val choices = ((outcome as AnonymousDiscoveryOutcome.Result).value as AnonymousDiscoveryResult.Multiple).choices
            assertEquals(listOf("atelier", "bureau"), choices.map { it.organisationSlug })
        } }
    }
    @Test fun testManualLookupGetsFreshKeyAndNoRetainedState() {
        WireFixture().use { wire -> wire.client().use { client ->
            repeat(2) { val result = OutcomeProbe(); client.discover("atelier", result::receive); result.await() }
            wire.awaitRequests(2); assertEquals(2, wire.requests.size)
            val keys = wire.requests.map { it.headers["idempotency-key"] }; assertTrue(keys.all { it != null }); assertNotEquals(keys[0], keys[1]); wire.requests.forEach(::assertAnonymous)
        } }
    }
}

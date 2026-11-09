package io.kodera.android.client

import io.kodera.android.domain.DomainFailure
import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `discoverRealm` at `contracts/v0.26.0`, end to end over a real TLS exchange with the loopback fixture: the
 * request Core checks before any quota charge, every documented answer, and the entry states they become.
 * Every wait is bounded: [OutcomeProbe.await] and [WireFixture.awaitRequests] by [Fixtures.COLD_START_MILLIS].
 */
class DiscoveryContractTests {
    private val browserHeaders = listOf("origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer")
    private val slug = DiscoveryQuery.Slug("atelier")
    private val noMatch = AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch)
    private val violation = AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation)

    private fun lookup(client: CoreDiscoveryClient, query: DiscoveryQuery): AnonymousDiscoveryOutcome {
        val probe = OutcomeProbe(); client.discover(query, probe::receive); return probe.await()
    }
    private fun presentation(outcome: AnonymousDiscoveryOutcome): DiscoveryPresentation {
        val state = DiscoveryState(); val ticket = state.begin(); state.receive(outcome, ticket)
        return DiscoveryPresentation.of(state.value)
    }
    /** The one-organisation contract example with its issuer (and the well-known URL derived from it) moved. */
    private fun oneWithIssuer(issuer: String): ByteArray {
        val obj = Fixtures.objectValue()
        obj.addProperty("issuer", issuer); obj.addProperty("openid_configuration_url", "$issuer/.well-known/openid-configuration")
        return Fixtures.bytes(obj)
    }
    private fun problemReply(status: Int, body: ByteArray, retry: String? = null) =
        WireReply(status, body, Fixtures.headers(true) + (retry?.let { listOf("Retry-After" to it) } ?: emptyList()))
    private fun single(outcome: AnonymousDiscoveryOutcome): AnonymousOrganisationMetadata {
        assertTrue("one organisation expected: $outcome", outcome is AnonymousDiscoveryOutcome.Result)
        val value = (outcome as AnonymousDiscoveryOutcome.Result).value
        assertTrue("one organisation expected: $value", value is AnonymousDiscoveryResult.Single)
        return (value as AnonymousDiscoveryResult.Single).metadata
    }

    // Fixtures are the contract's examples

    @Test fun testFixturesAreTheContractExamples() {
        val atelier = AnonymousOrganisationMetadata("11111111-1111-4111-8111-111111111111", "atelier", "Atelier Example",
            "atelier", "https://id.kodera.io/realms/atelier", "https://id.kodera.io/realms/atelier/.well-known/openid-configuration")
        val bureau = AnonymousOrganisationMetadata("22222222-2222-4222-8222-222222222222", "bureau", "Bureau Example",
            "bureau", "https://id.kodera.io/realms/bureau", "https://id.kodera.io/realms/bureau/.well-known/openid-configuration")
        assertEquals(AnonymousDiscoveryResult.NoMatch, DiscoveryEnvelope.decode(Fixtures.data("zero"), Fixtures.configuration()))
        assertEquals(AnonymousDiscoveryResult.Single(atelier), DiscoveryEnvelope.decode(Fixtures.data("one"), Fixtures.configuration()))
        assertEquals(AnonymousDiscoveryResult.Multiple(listOf(atelier, bureau)),
            DiscoveryEnvelope.decode(Fixtures.data("many"), Fixtures.configuration()))
    }

    // The request

    @Test fun testRequestCarriesTheHeadersCoreChecksBeforeAnyQuotaCharge() {
        WireFixture().use { wire -> wire.client().use { client ->
            assertEquals(noMatch, lookup(client, slug)); assertEquals(noMatch, lookup(client, slug))
            wire.awaitRequests(2)
            // DiscoveryCompatibilityKey: ^[!-~][ -~]{14,253}[!-~]$, validated then discarded by Core.
            val compatibility = Regex("[!-~][ -~]{14,253}[!-~]")
            for (request in wire.requests) {
                assertEquals("POST", request.method); assertEquals("/api/v1/auth/discover", request.target)
                assertEquals("core.test", request.headers["host"])
                assertEquals("application/json", request.headers["content-type"])
                assertAnonymous(request)
                val key = request.headers["idempotency-key"]
                assertNotNull("compatibility key required", key)
                assertTrue(key!!, compatibility.matches(key))
            }
            assertEquals("every lookup sends a fresh compatibility key", 2,
                wire.requests.map { it.headers["idempotency-key"] }.toSet().size)
        } }
    }

    /**
     * Core refuses a browser's request from `Origin` or `Sec-Fetch-Site` before any quota charge; a request
     * carrying neither is a native client's and is never refused for its origin.
     */
    @Test fun testNativeRequestSendsNeitherOriginNorSecFetchSite() {
        WireFixture().use { wire -> wire.client().use { client ->
            lookup(client, slug); lookup(client, DiscoveryQuery.Email("member@atelier.example"))
            wire.awaitRequests(2)
            assertEquals(2, wire.requests.size)
            for (request in wire.requests) for (name in browserHeaders) {
                assertFalse("a native discovery request sent $name", request.headers.containsKey(name))
            }
        } }
    }

    @Test fun testEmailLookupSendsOnlyTheEmailAndZeroResultsMeanNoOrganisation() {
        WireFixture().use { wire -> wire.client().use { client ->
            val outcome = lookup(client, DiscoveryQuery.Email("member@atelier.example"))
            assertEquals(noMatch, outcome)
            assertEquals("zero candidates is no organisation, never an error", DiscoveryPresentation.NoOrganisation, presentation(outcome))
            wire.awaitRequests()
            val request = wire.requests.single()
            assertEquals("""{"email":"member@atelier.example"}""", request.body.toString(Charsets.UTF_8))
            assertNotNull(request.headers["idempotency-key"]); assertAnonymous(request)
        } }
    }

    @Test fun testOnlyAnApprovedEmailIsSent() {
        WireFixture().use { wire -> wire.client().use { client ->
            val refused = listOf("", "member", "member@", "@atelier.example", "member@localhost", "member@atelier..example",
                "member@-atelier.example", "mem ber@atelier.example", "membré@atelier.example", "member@atelier.example\n",
                "a".repeat(65) + "@atelier.example", "a@" + List(4) { "b".repeat(63) }.joinToString("."),
                "member@atelier.example.", ".member@atelier.example", "member.@atelier.example", "me\"mber@atelier.example")
            for (email in refused) {
                assertEquals(email, AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.InvalidInput), lookup(client, DiscoveryQuery.Email(email)))
            }
            assertEquals("an unapproved email never leaves the device", 0, wire.requests.size)
            for (email in listOf("Member.Name+tag@Atelier.Example", "a".repeat(64) + "@atelier.example", "o'neil@atelier.example")) {
                assertEquals(email, noMatch, lookup(client, DiscoveryQuery.Email(email)))
            }
            wire.awaitRequests(3); assertEquals(3, wire.requests.size)
        } }
    }

    @Test fun testASingleMatchMustBeTheQueriedSlugButAnEmailMatchNeedNot() {
        WireFixture(reply = { WireReply(body = Fixtures.data()) }).use { wire -> wire.client().use { client ->
            assertEquals("a slug answers with that organisation or none", violation, lookup(client, DiscoveryQuery.Slug("bureau")))
            assertEquals("atelier", single(lookup(client, DiscoveryQuery.Email("member@atelier.example"))).organisationSlug)
        } }
    }

    // The discovered issuer

    /**
     * The issuer goes through [IssuerAdmission], the validator sign-in runs. One outside the configured origins
     * makes the whole answer unusable: no [DiscoveryPresentation.Found], so no sign-in can start and no browser opens.
     */
    @Test fun testDiscoveredIssuerOutsideTheConfiguredOriginsIsRefusedBeforeAnyBrowserOpens() {
        for (issuer in listOf("https://id.other.example/realms/atelier", "https://id.kodera.io.evil.example/realms/atelier",
            "https://id.kodera.io:8443/realms/atelier", "http://localhost:8080/realms/atelier")) {
            val body = oneWithIssuer(issuer)
            WireFixture(reply = { WireReply(body = body) }).use { wire -> wire.client().use { client ->
                val outcome = lookup(client, slug)
                assertEquals(issuer, violation, outcome)
                assertEquals(issuer, DiscoveryPresentation.InvalidResponse, presentation(outcome))
                assertNull("$issuer must never reach sign-in", presentation(outcome).signInIssuer)
            } }
        }
        val many = Fixtures.objectValue("many")
        many.getAsJsonArray("candidates")[1].asJsonObject.apply {
            addProperty("issuer", "https://id.other.example/realms/bureau")
            addProperty("openid_configuration_url", "https://id.other.example/realms/bureau/.well-known/openid-configuration")
        }
        val body = Fixtures.bytes(many)
        WireFixture(reply = { WireReply(body = body) }).use { wire -> wire.client().use { client ->
            assertEquals("one foreign candidate refuses the whole answer", violation, lookup(client, slug))
        } }
    }

    @Test fun testALoopbackIssuerIsAdmittedOnlyUnderTheDevelopmentPolicy() {
        val issuer = "http://localhost:8080/realms/atelier"
        val body = oneWithIssuer(issuer)
        WireFixture(reply = { WireReply(body = body) }).use { wire ->
            CoreDiscoveryClient(Fixtures.configuration(), wire.route(), Fixtures.COLD_START_MILLIS).use { client ->
                assertEquals(violation, lookup(client, slug))
            }
            var refusedConfiguration = false
            try { CoreDiscoveryConfiguration.configured("https://core.test", setOf("http://localhost:8080")) }
            catch (_: DomainFailure) { refusedConfiguration = true }
            assertTrue("a loopback origin cannot be configured without the development policy", refusedConfiguration)
            val development = CoreDiscoveryConfiguration.configured("https://core.test", setOf("http://localhost:8080"),
                LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
            CoreDiscoveryClient(development, wire.route(), Fixtures.COLD_START_MILLIS).use { client ->
                assertEquals(issuer, single(lookup(client, slug)).issuer)
            }
        }
    }

    @Test fun testAFoundOrganisationsIssuerIsOneSignInAdmits() {
        WireFixture(reply = { WireReply(body = Fixtures.data()) }).use { wire -> wire.client().use { client ->
            val issuer = presentation(lookup(client, slug)).signInIssuer
            assertNotNull("one organisation offers sign-in", issuer)
            val admitted = IssuerAdmission.admit(issuer!!, setOf("https://id.kodera.io"), LoopbackPolicy.REFUSE)
            assertEquals("atelier", admitted.realm); assertEquals("https://id.kodera.io", admitted.origin)
        } }
    }

    // Every documented answer

    private data class ProblemCase(val status: Int, val type: String, val retry: String?, val extra: String, val expected: DiscoveryFailure)

    @Test fun testEveryDocumentedProblemReachesItsTypedOutcome() {
        val correlation = ProblemCorrelation(Fixtures.REQUEST_ID)
        val cases = listOf(
            ProblemCase(400, "malformed-request", null, "", DiscoveryFailure.RejectedRequest(RequestRejection.MALFORMED_REQUEST)),
            ProblemCase(400, "idempotency-key-missing", null, "", DiscoveryFailure.RejectedRequest(RequestRejection.IDEMPOTENCY_KEY_MISSING)),
            ProblemCase(403, "forbidden", null, "", DiscoveryFailure.RejectedRequest(RequestRejection.FORBIDDEN)),
            ProblemCase(413, "payload-too-large", null, ",\"limit_bytes\":4096", DiscoveryFailure.RejectedRequest(RequestRejection.PAYLOAD_TOO_LARGE)),
            ProblemCase(415, "unsupported-media-type", null, "", DiscoveryFailure.RejectedRequest(RequestRejection.UNSUPPORTED_MEDIA_TYPE)),
            ProblemCase(422, "validation-error", null, ",\"errors\":[{\"pointer\":\"/slug\",\"code\":\"pattern\"}]",
                DiscoveryFailure.RejectedRequest(RequestRejection.VALIDATION_ERROR)),
            ProblemCase(429, "rate-limited", "3", "", DiscoveryFailure.RateLimited(RetryHint(3), correlation)),
            ProblemCase(500, "internal-error", null, "", DiscoveryFailure.InternalServiceError(correlation)),
            ProblemCase(503, "service-unavailable", "5", "", DiscoveryFailure.TemporarilyUnavailable(RetryHint(5), correlation)),
        )
        for (case in cases) {
            val body = (Fixtures.problem(case.status, case.type, case.retry).toString(Charsets.UTF_8).dropLast(1) + case.extra + "}")
                .toByteArray(Charsets.UTF_8)
            WireFixture(reply = { problemReply(case.status, body, case.retry) }).use { wire -> wire.client().use { client ->
                assertEquals(case.type, AnonymousDiscoveryOutcome.Failure(case.expected), lookup(client, slug))
                wire.awaitRequests(); assertEquals(case.type, 1, wire.requests.size)
            } }
        }
    }

    @Test fun testAPayloadLimitThatIsNotACountRefuses() {
        for (limit in listOf("\"4096\"", "-1", "1.5", "true", "null")) {
            val body = Fixtures.problem(413, "payload-too-large").toString(Charsets.UTF_8).dropLast(1) + ",\"limit_bytes\":$limit}"
            Fixtures.refused { DiscoveryProblem.decode(body.toByteArray(Charsets.UTF_8), 413, Fixtures.headers(true)) }
        }
    }

    /** Quotas are per IP and looked-up value: one lookup is one request, and a quota answer is shown, not retried. */
    @Test fun testAQuotaAnswerIsOneRequestAndReadsTryAgainLater() {
        WireFixture(reply = { problemReply(429, Fixtures.problem(429, "rate-limited", "7"), "7") }).use { wire -> wire.client().use { client ->
            val outcome = lookup(client, slug)
            assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.RateLimited(RetryHint(7), ProblemCorrelation(Fixtures.REQUEST_ID))), outcome)
            Thread.sleep(200)
            assertEquals("a quota answer is never retried", 1, wire.requests.size)
            assertEquals(DiscoveryPresentation.TryAgainLater, presentation(outcome))
        } }
    }

    @Test fun testAnUnavailableServiceIsOneRequestToo() {
        WireFixture(reply = { problemReply(503, Fixtures.problem(503, "service-unavailable", "5"), "5") }).use { wire -> wire.client().use { client ->
            val outcome = lookup(client, slug)
            Thread.sleep(200)
            assertEquals(1, wire.requests.size)
            assertEquals(DiscoveryPresentation.ServiceUnavailable, presentation(outcome))
        } }
    }

    // The entry states

    @Test fun testEveryStateHasItsTypedEntryState() {
        val atelier = Fixtures.selected()
        val bureau = atelier.copy(organisationId = "22222222-2222-4222-8222-222222222222", organisationSlug = "bureau", realm = "bureau")
        val correlation = ProblemCorrelation(Fixtures.REQUEST_ID)
        val table = listOf(
            AnonymousDiscoveryState.Editing to DiscoveryPresentation.Ready,
            AnonymousDiscoveryState.Loading to DiscoveryPresentation.Searching,
            AnonymousDiscoveryState.Cancelled to DiscoveryPresentation.Cancelled,
            AnonymousDiscoveryState.NoMatch to DiscoveryPresentation.NoOrganisation,
            AnonymousDiscoveryState.Selected(atelier) to DiscoveryPresentation.Found(atelier),
            AnonymousDiscoveryState.Choosing(listOf(atelier, bureau)) to DiscoveryPresentation.SeveralCandidates(listOf(atelier, bureau)),
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.RateLimited(RetryHint(1), correlation)) to DiscoveryPresentation.TryAgainLater,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.Transport(TransportFailure.OFFLINE)) to DiscoveryPresentation.NetworkError(TransportFailure.OFFLINE),
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.Transport(TransportFailure.TIMEOUT)) to DiscoveryPresentation.NetworkError(TransportFailure.TIMEOUT),
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.Transport(TransportFailure.TLS)) to DiscoveryPresentation.NetworkError(TransportFailure.TLS),
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.TemporarilyUnavailable(RetryHint(5), correlation)) to DiscoveryPresentation.ServiceUnavailable,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.InternalServiceError(correlation)) to DiscoveryPresentation.ServiceUnavailable,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.UnsupportedService) to DiscoveryPresentation.ServiceUnavailable,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.RejectedRequest(RequestRejection.FORBIDDEN)) to DiscoveryPresentation.RequestRefused,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.RejectedRequest(RequestRejection.VALIDATION_ERROR)) to DiscoveryPresentation.RequestRefused,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.ProtocolViolation) to DiscoveryPresentation.InvalidResponse,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.InvalidInput) to DiscoveryPresentation.InvalidInput,
            AnonymousDiscoveryState.Unavailable(DiscoveryFailure.NotConfigured) to DiscoveryPresentation.NotConfigured,
        )
        for ((state, expected) in table) {
            assertEquals(state.toString(), expected, DiscoveryPresentation.of(state))
            if (expected is DiscoveryPresentation.Found) assertEquals(atelier.issuer, DiscoveryPresentation.of(state).signInIssuer)
            else assertNull("only a found organisation offers sign-in: $state", DiscoveryPresentation.of(state).signInIssuer)
        }
    }

    @Test fun testChoosingOneOfSeveralCandidatesFindsIt() {
        val atelier = Fixtures.selected()
        val bureau = atelier.copy(organisationId = "22222222-2222-4222-8222-222222222222", organisationSlug = "bureau", realm = "bureau",
            issuer = "https://id.kodera.io/realms/bureau")
        val state = DiscoveryState(); val ticket = state.begin()
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.Multiple(listOf(atelier, bureau))), ticket)
        assertNull("several candidates need a choice first", DiscoveryPresentation.of(state.value).signInIssuer)
        state.select(bureau.organisationId)
        assertEquals(DiscoveryPresentation.Found(bureau), DiscoveryPresentation.of(state.value))
        assertEquals(bureau.issuer, DiscoveryPresentation.of(state.value).signInIssuer)
    }
}

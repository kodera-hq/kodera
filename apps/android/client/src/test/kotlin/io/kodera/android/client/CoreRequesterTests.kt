package io.kodera.android.client

import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Records what a Core client asked of the sign-in owner. Each token comes from its own session. */
internal class FakeTokens(private val refusesRefresh: Boolean = false, private val unavailable: Boolean = false,
    private val prefix: String = "synthetic-access-") : AccessTokenProvider {
    private val issued = AtomicInteger()
    /** Every call for a token, served or not. */
    val requested = AtomicInteger()
    val forcedRefreshes = AtomicInteger()
    /** Local session ends, the owner's own (a refused refresh) included. Nothing here revokes. */
    val signOuts = AtomicInteger()
    val ended = CopyOnWriteArrayList<AccessToken>()
    override fun accessToken(forceRefresh: Boolean): AccessToken {
        requested.incrementAndGet()
        if (unavailable) throw AccessTokenException(AccessTokenFailure.UNAVAILABLE)
        if (forceRefresh) {
            forcedRefreshes.incrementAndGet()
            if (refusesRefresh) {
                signOuts.incrementAndGet() // the owner wipes its own state when a refresh is refused
                throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
            }
        }
        val n = issued.incrementAndGet()
        return AccessToken("$prefix$n", 100L + n)
    }
    override fun endSession(token: AccessToken) { ended += token; signOuts.incrementAndGet() }
}

/** Serves tokens as [FakeTokens] does, and closes [target] as it serves the first one, or the forced refresh. */
private class ClosingTokens(private val onForcedRefresh: Boolean) : AccessTokenProvider {
    val inner = FakeTokens()
    @Volatile var target: CoreRequester? = null
    override fun accessToken(forceRefresh: Boolean): AccessToken {
        val token = inner.accessToken(forceRefresh)
        if (forceRefresh == onForcedRefresh) target?.close()
        return token
    }
    override fun endSession(token: AccessToken) = inner.endSession(token)
}

/**
 * The shared Core request path: bound to one origin, bearer, one refresh and one retry on 401, a local
 * end of only the session the refused token came from, 403 without retry, and no redirect. Each caller
 * reads the body.
 */
class CoreRequesterTests {
    private val headers = listOf("Content-Type" to "application/json", "Cache-Control" to "no-store")
    private fun ok() = WireReply(200, """{"synthetic":true}""".toByteArray(), headers)
    private fun status(code: Int) = WireReply(code, """{"type":"about:blank","status":$code}""".toByteArray(),
        listOf("Content-Type" to "application/problem+json"))

    /** The reader's view of an answer: its status, and that it was read inside the response's lifetime. */
    private val code: (okhttp3.Response) -> Int = { it.code }

    private fun <T> get(tokens: FakeTokens, read: (okhttp3.Response) -> T, path: String = "/api/v1/resource",
        reply: (RecordedRequest) -> WireReply): Pair<CoreReply<T>, List<RecordedRequest>> =
        WireFixture(reply = reply).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                requester.get(path, read) to wire.requests.toList()
            }
        }

    @Test fun testTheOriginIsValidatedOnceWhenTheRequesterIsBuilt() {
        for (origin in listOf("http://core.test", "https://core.test/", "https://core.test:8443", "https://core.test/api",
            "https://user@core.test", "http://localhost:8000", "")) {
            try { CoreRequester(origin, LoopbackPolicy.REFUSE, FakeTokens()).close(); fail(origin) }
            catch (_: IllegalArgumentException) { }
        }
        CoreRequester("http://localhost:8000", LoopbackPolicy.ADMIT_FOR_DEVELOPMENT, FakeTokens()).close()
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).close()
    }

    /** Paths on the origin go out to it unchanged. */
    @Test fun testAPathOnTheOriginIsSentThere() {
        for (path in listOf("/api/v1/me", "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/channels",
            "/a-b_c~d.e/...", "/v1.2")) {
            val (reply, requests) = get(FakeTokens(), code, path) { ok() }
            assertEquals(path, CoreReply.Answered(200), reply)
            assertEquals(path, listOf("core.test" to path), requests.map { it.headers["host"] to it.target })
        }
    }

    /** Each refused path asks for no token and sends nothing. */
    private fun assertRefusedBeforeAnyToken(paths: List<String>, rule: String) {
        for (path in paths) {
            val tokens = FakeTokens()
            val (reply, requests) = get(tokens, code, path) { ok() }
            assertEquals("$rule admitted $path", CoreReply.PathRefused, reply)
            assertEquals("a token was asked for before $path was refused", 0, tokens.requested.get())
            assertTrue("$path reached the transport", requests.isEmpty())
        }
    }

    /**
     * Owned by the leading-slash rule: without it, the first two would extend the origin's host. The
     * absolute URL is also refused by the character rule, for its `:`.
     */
    @Test fun testAPathWithoutItsLeadingSlashIsRefused() =
        assertRefusedBeforeAnyToken(listOf(".evil.test/api/v1/me", "api/v1/me", "", "https://evil.test/api/v1/me"),
            "the leading-slash rule")

    /** Owned by the empty-segment rule: a scheme-relative `//host`, and any empty segment. */
    @Test fun testAnEmptySegmentIsRefused() =
        assertRefusedBeforeAnyToken(listOf("//evil.test/api/v1/me", "/api//me", "/api/v1/me/", "/"),
            "the empty-segment rule")

    /** Owned by the dot-segment rule: without it, OkHttp would resolve these to other paths on the origin. */
    @Test fun testADotSegmentIsRefused() =
        assertRefusedBeforeAnyToken(listOf("/api/v1/../../evil", "/..", "/api/./me", "/."), "the dot-segment rule")

    /**
     * Owned by the character rule: user info, backslash (OkHttp reads it as `/`), every percent-encoded
     * variant, port or scheme separators, query, fragment, whitespace and non-ASCII.
     */
    @Test fun testACharacterOutsideTheUnreservedSetIsRefused() =
        assertRefusedBeforeAnyToken(listOf("/api/v1/me@evil.test", "/@evil.test", "/api\\evil.test", "/%2e%2e/evil",
            "/api%2fv1", "/%40evil.test", "/%5cevil.test", "/x:443", "/api/v1/me?next=https", "/api/v1/me#x",
            "/api/v1 /me", "/api/v1/m\u00e9", "/api/v1/me\n"), "the character rule")

    /** The session that owned the requester has ended: nothing more goes out through it. */
    @Test fun testAClosedRequesterSendsNothing() {
        val tokens = FakeTokens()
        WireFixture(reply = { ok() }).use { wire ->
            val requester = CoreRequester("https://core.test", tokens, wire.route(), 2000)
            assertFalse(requester.isClosed)
            requester.close()
            assertTrue("close did not mark the requester closed", requester.isClosed)
            assertEquals(CoreReply.Transport(TransportFailure.OTHER), requester.get("/api/v1/resource", code))
            assertEquals("a closed requester asked for a token", 0, tokens.requested.get())
            assertTrue("a closed requester sent a request", wire.requests.isEmpty())
        }
    }

    /**
     * A request through a requester that [aim] receives, against a fixture answering with [reply]. Each
     * test below asserts first what its own check owns, so a removed check fails there and not elsewhere.
     */
    private fun closing(tokens: AccessTokenProvider, aim: (CoreRequester) -> Unit,
        reply: (RecordedRequest) -> WireReply): Pair<CoreReply<Int>, List<RecordedRequest>> =
        WireFixture(reply = reply).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                aim(requester)
                requester.get("/api/v1/resource", code) to wire.requests.toList()
            }
        }

    /** Owned by the check before each send: closed while the first token was fetched, nothing goes out. */
    @Test fun testARequesterClosedWhileFetchingItsTokenSendsNothing() {
        val tokens = ClosingTokens(onForcedRefresh = false)
        val (reply, requests) = closing(tokens, { tokens.target = it }) { status(401) }
        assertTrue("a request went out after the requester was closed", requests.isEmpty())
        assertEquals(CoreReply.Transport(TransportFailure.OTHER), reply)
    }

    /** Owned by the check before each send: closed during the 401's forced refresh, the retry never goes out. */
    @Test fun testARequesterClosedDuringTheRefreshSendsNoRetry() {
        val tokens = ClosingTokens(onForcedRefresh = true)
        val (reply, requests) = closing(tokens, { tokens.target = it }) { status(401) }
        assertEquals("a retry went out after the requester was closed", 1, requests.size)
        assertTrue("a closed requester ended the session", tokens.inner.ended.isEmpty())
        assertEquals(CoreReply.Transport(TransportFailure.OTHER), reply)
    }

    /**
     * Owned by the check before the forced refresh: closed while Core answered the first attempt with a
     * 401, the requester refreshes nothing (the grant may now be a new session's) and sends no retry.
     */
    @Test fun testARequesterClosedWhileCoreAnswersTheFirstAttemptRefreshesNothing() {
        val tokens = FakeTokens()
        val target = AtomicReference<CoreRequester>()
        val (reply, requests) = closing(tokens, { target.set(it) }) { target.get().close(); status(401) }
        assertEquals("a forced refresh was asked for after the requester was closed", 0, tokens.forcedRefreshes.get())
        assertEquals("a retry went out after the requester was closed", 1, requests.size)
        assertTrue("a closed requester ended the session", tokens.ended.isEmpty())
        assertEquals(CoreReply.Transport(TransportFailure.OTHER), reply)
    }

    /**
     * Owned by the check in [CoreRequester.endSession]: closed while Core answered the retry with a 401,
     * the requester ends no session. Otherwise a late second 401 after a sign-out would wipe a session
     * without revoking it.
     */
    @Test fun testARequesterClosedWhileCoreAnswersTheRetryEndsNoSession() {
        val tokens = FakeTokens()
        val target = AtomicReference<CoreRequester>()
        val seen = AtomicInteger()
        val (reply, requests) = closing(tokens, { target.set(it) }) {
            if (seen.incrementAndGet() == 2) target.get().close()
            status(401)
        }
        assertTrue("a closed requester ended the session", tokens.ended.isEmpty())
        assertEquals("one attempt and one retry", 2, requests.size)
        assertEquals(1, tokens.forcedRefreshes.get())
        assertEquals(CoreReply.Transport(TransportFailure.OTHER), reply)
    }

    @Test fun testSendsTheBearerTokenAndHandsTheAnswerToTheReader() {
        val tokens = FakeTokens()
        val (reply, requests) = get(tokens, { it.code to it.body.string() }) { ok() }
        assertEquals(CoreReply.Answered(200 to """{"synthetic":true}"""), reply)
        val request = requests.single()
        assertEquals("GET", request.method)
        assertEquals("/api/v1/resource", request.target)
        assertEquals("core.test", request.headers["host"])
        assertEquals("Bearer synthetic-access-1", request.headers["authorization"])
        assertEquals("application/json, application/problem+json", request.headers["accept"])
        assertEquals("no-store", request.headers["cache-control"])
        assertEquals("identity", request.headers["accept-encoding"])
        for (name in listOf("cookie", "if-none-match", "proxy-authorization")) assertTrue(name, name !in request.headers)
        assertEquals(0, tokens.forcedRefreshes.get())
    }

    @Test fun testUnauthorizedRefreshesOnceThenRetries() {
        val tokens = FakeTokens()
        val (reply, requests) = get(tokens, code) {
            if (it.headers["authorization"] == "Bearer synthetic-access-1") status(401) else ok()
        }
        assertEquals("the retry's answer is not the one returned", CoreReply.Answered(200), reply)
        assertEquals(1, tokens.forcedRefreshes.get())
        assertEquals(listOf("Bearer synthetic-access-1", "Bearer synthetic-access-2"), requests.map { it.headers["authorization"] })
        assertEquals(0, tokens.signOuts.get())
    }

    /** The second 401 ends, locally, the session of the refreshed token that Core refused, and no other. */
    @Test fun testUnauthorizedAfterRefreshEndsOnlyTheSessionThatServedTheToken() {
        val tokens = FakeTokens()
        val (reply, requests) = get(tokens, code) { status(401) }
        assertEquals(CoreReply.SignedOut, reply)
        assertEquals("no third attempt", 2, requests.size)
        assertEquals("exactly one refresh", 1, tokens.forcedRefreshes.get())
        assertEquals(1, tokens.signOuts.get())
        assertEquals("the end did not name the session that served the refreshed token",
            listOf("synthetic-access-2" to 102L), tokens.ended.map { it.value to it.session })
    }

    /** A caller whose thread was interrupted by the second 401 has moved on: it ends no session. */
    @Test fun testAnInterruptedCallerEndsNoSession() {
        val tokens = FakeTokens()
        val token = AccessToken("synthetic-access-2", 102L)
        WireFixture().use { wire -> CoreRequester("https://core.test", tokens, wire.route(), 2000).use { requester ->
            val interrupted = try {
                Thread.currentThread().interrupt()
                requester.endSession(token)
            } finally { Thread.interrupted() }
            assertEquals(CoreReply.Transport(TransportFailure.OTHER), interrupted)
            assertTrue("an interrupted caller ended the session", tokens.ended.isEmpty())

            assertEquals("a caller still running ends the session of its token", CoreReply.SignedOut, requester.endSession(token))
            assertEquals(listOf(102L), tokens.ended.map { it.session })
        } }
    }

    @Test fun testRefusedRefreshIsSignedOutWithoutRetry() {
        val tokens = FakeTokens(refusesRefresh = true)
        val (reply, requests) = get(tokens, code) { status(401) }
        assertEquals(CoreReply.SignedOut, reply)
        assertEquals("a refused refresh was followed by a retry", 1, requests.size)
        assertTrue(tokens.ended.isEmpty())
    }

    @Test fun testUnreachableIdentityProviderSendsNothing() {
        val (reply, requests) = get(FakeTokens(unavailable = true), code) { ok() }
        assertEquals(CoreReply.IdentityUnavailable, reply)
        assertTrue(requests.isEmpty())
    }

    @Test fun testForbiddenIsNeitherRetriedNorASignOut() {
        val tokens = FakeTokens()
        val read = AtomicInteger()
        val (reply, requests) = get(tokens, { read.incrementAndGet() }) {
            if (it.headers["authorization"] == "Bearer synthetic-access-1") status(403) else ok()
        }
        assertEquals(CoreReply.Forbidden, reply)
        assertEquals("a 403 is not retried", 1, requests.size)
        assertEquals(0, tokens.forcedRefreshes.get())
        assertEquals(0, tokens.signOuts.get())
        assertEquals("a 403 reached the reader", 0, read.get())
    }

    /** Every other status is the reader's to map: no refresh, no retry, no session end. */
    @Test fun testOtherStatusesGoToTheReader() {
        for (status in listOf(304, 404, 429, 500, 503)) {
            val tokens = FakeTokens()
            val (reply, requests) = get(tokens, code) { status(status) }
            assertEquals("$status", CoreReply.Answered(status), reply)
            assertEquals("$status", 1, requests.size)
            assertEquals("$status", 0, tokens.forcedRefreshes.get())
            assertEquals("$status", 0, tokens.signOuts.get())
        }
    }

    @Test fun testRedirectIsNeverFollowedWithTheToken() {
        val (reply, requests) = get(FakeTokens(), code) {
            WireReply(302, ByteArray(0), listOf("Location" to "https://core.test/elsewhere"))
        }
        assertEquals(CoreReply.Answered(302), reply)
        assertEquals("the redirect was followed", 1, requests.size)
    }

    @Test fun testAReaderThatCannotReadTheBodyIsATransportFailure() {
        val (reply, _) = get(FakeTokens(), { throw IOException("synthetic read failure") }) { ok() }
        assertEquals(CoreReply.Transport(TransportFailure.OTHER), reply)
    }

    @Test fun testATokenOkHttpRefusesSendsNothing() {
        val (reply, requests) = get(FakeTokens(prefix = "synthetic\naccess-"), code) { ok() }
        assertEquals(CoreReply.Unsendable, reply)
        assertTrue(requests.isEmpty())
    }

    @Test fun testOfflineIsATransportFailure() {
        // The fixture is closed before the call: nothing listens on its port any more.
        val route = WireFixture().use { it.route() }
        CoreRequester("https://core.test", FakeTokens(), route, 1000).use { requester ->
            val reply = requester.get("/api/v1/resource", code)
            assertTrue("$reply", reply is CoreReply.Transport)
        }
    }

    @Test fun testTheBodyLimitIsEnforced() {
        val exact = ByteArray(CoreRequester.BODY_LIMIT) { 32 }
        assertEquals(CoreRequester.BODY_LIMIT, CoreRequester.bounded(exact.inputStream())?.size)
        assertEquals(null, CoreRequester.bounded(ByteArray(CoreRequester.BODY_LIMIT + 1) { 32 }.inputStream()))
    }
    @Test fun realServiceConstructorsCaptureAbsentOrCurrentOwnerOnce() {
        val issuer = "https://auth.kodera.test/realms/acme-sa"
        val configuration = SignInConfiguration("synthetic-client", setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE)
        val first = StoredGrant(issuer, "G1")
        val second = StoredGrant(issuer, "G2")
        val backend = FakeBackend { first }
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        WireFixture(reply = { ok() }).use { wire ->
            CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { absent ->
                val old = service.signInAccepted(issuer)
                CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r1 ->
                    backend.authorizeResult = { second }; service.signInAccepted(issuer)
                    assertFalse(r1.isClosed)
                    assertEquals(CoreReply.SignedOut, absent.get("/api/v1/me", code))
                    assertEquals(CoreReply.SignedOut, r1.get("/api/v1/me", code))
                    assertTrue(backend.refreshes.isEmpty()); assertTrue(wire.requests.isEmpty())
                    // Explicit acceptance constructor cannot recapture the service's new owner either.
                    CoreRequester("https://core.test", LoopbackPolicy.REFUSE, old).use { stale ->
                        assertEquals(CoreReply.SignedOut, stale.get("/api/v1/me", code))
                    }
                    backend.refreshResults += { FreshToken("synthetic-G2", second) }
                    CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r2 ->
                        assertEquals(CoreReply.Answered(200), r2.get("/api/v1/me", code))
                    }
                    assertEquals(listOf("Bearer synthetic-G2"), wire.requests.map { it.headers["authorization"] })
                }
            }
        }
    }

    @Test fun retiredBeforeSendAdmissionSendsNoHttpWithOldRequesterOpen() = sendAdmissionRace(false)
    @Test fun admittedSendMayFinishOnlyWithOldTokenAfterReplacement() = sendAdmissionRace(true)

    private fun sendAdmissionRace(afterAdmission: Boolean) {
        val issuer = "https://auth.kodera.test/realms/acme-sa"
        val configuration = SignInConfiguration("synthetic-client", setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE)
        val first = StoredGrant(issuer, "G1"); val second = StoredGrant(issuer, "G2")
        val backend = FakeBackend { first }
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        service.signInAccepted(issuer)
        backend.refreshResults += { FreshToken("synthetic-G1", first) }
        val reached = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val gate = { reached.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "S gate not released" }; Unit }
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            WireFixture(reply = { ok() }).use { wire ->
                CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS,
                    if (afterAdmission) SendAdmissionGates(after = gate) else SendAdmissionGates(before = gate)).use { r1 ->
                    val result = worker.submit<CoreReply<Int>> { r1.get("/api/v1/me", code) }
                    assertTrue("S gate not reached", reached.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    backend.authorizeResult = { second }; val replacement = service.signInAccepted(issuer)
                    assertFalse("closure must not mask S", r1.isClosed)
                    release.countDown()
                    val answered = result.get(Fixtures.COLD_START_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS)
                    assertEquals("S must refuse retired HTTP and retain only an admitted G1 token",
                        if (afterAdmission) listOf("Bearer synthetic-G1") else emptyList<String>(), wire.requests.map { it.headers["authorization"] })
                    assertEquals(if (afterAdmission) CoreReply.Answered(200) else CoreReply.SignedOut, answered)
                    org.junit.Assert.assertSame(replacement, service.captureAcceptedOwner())
                    backend.refreshResults += { FreshToken("synthetic-G2", second) }
                    CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r2 ->
                        assertEquals(CoreReply.Answered(200), r2.get("/api/v1/me", code))
                    }
                }
            }
        } finally {
            release.countDown(); worker.shutdownNow(); assertTrue(worker.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS))
        }
    }

    @Test fun heldOld401CannotRefreshOrEndReplacementWithRequesterOpen() {
        for (heldAttempt in listOf(1, 2)) {
            val issuer = "https://auth.kodera.test/realms/acme-sa"
            val configuration = SignInConfiguration("synthetic-client", setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE)
            val first = StoredGrant(issuer, "G1"); val second = StoredGrant(issuer, "G2")
            val backend = FakeBackend { first }
            val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
            service.signInAccepted(issuer)
            repeat(heldAttempt) { backend.refreshResults += { FreshToken("synthetic-G1", first) } }
            val release = java.util.concurrent.CountDownLatch(1)
            val count = AtomicInteger()
            val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
            try {
                WireFixture(reply = { if (count.incrementAndGet() == heldAttempt) status(401).copy(hold = release) else status(401) }).use { wire ->
                    CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r1 ->
                        val result = worker.submit<CoreReply<Int>> { r1.get("/api/v1/me", code) }
                        wire.awaitRequests(heldAttempt)
                        backend.authorizeResult = { second }; val replacement = service.signInAccepted(issuer)
                        assertFalse(r1.isClosed)
                        release.countDown()
                        assertEquals(CoreReply.SignedOut, result.get(Fixtures.COLD_START_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS))
                        assertEquals(heldAttempt, wire.requests.size)
                        assertEquals(heldAttempt, backend.refreshes.size)
                        assertTrue(backend.refreshes.all { it.first == first })
                        org.junit.Assert.assertSame(replacement, service.captureAcceptedOwner())
                        assertTrue(backend.revoked.isEmpty())
                    }
                }
            } finally {
                release.countDown(); worker.shutdownNow(); assertTrue(worker.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS))
            }
        }
    }

    @Test fun sameOwner401RotationAndCurrentSecond401KeepExistingSemantics() {
        val issuer = "https://auth.kodera.test/realms/acme-sa"
        val configuration = SignInConfiguration("synthetic-client", setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE)
        val first = StoredGrant(issuer, "G1"); val rotated = StoredGrant(issuer, "G1-rotated")
        val backend = FakeBackend { first }
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val owner = service.signInAccepted(issuer)
        backend.refreshResults += { FreshToken("synthetic-first", first) }
        backend.refreshResults += { FreshToken("synthetic-rotated", rotated) }
        val count = AtomicInteger()
        WireFixture(reply = { if (count.incrementAndGet() == 1) status(401) else ok() }).use { wire ->
            CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r ->
                assertEquals(CoreReply.Answered(200), r.get("/api/v1/me", code))
                org.junit.Assert.assertSame(owner, service.captureAcceptedOwner())
                assertFalse(owner.isRetired)
                assertEquals(listOf("Bearer synthetic-first", "Bearer synthetic-rotated"), wire.requests.map { it.headers["authorization"] })
            }
        }
        repeat(2) { backend.refreshResults += { FreshToken("synthetic-rotated", rotated) } }
        WireFixture(reply = { status(401) }).use { wire ->
            CoreRequester("https://core.test", service, wire.route(), Fixtures.COLD_START_MILLIS).use { r ->
                assertEquals(CoreReply.SignedOut, r.get("/api/v1/me", code))
            }
        }
        assertTrue(owner.isRetired); assertFalse(service.isSignedIn); assertTrue(backend.revoked.isEmpty())
    }

}

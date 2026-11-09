package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test
import java.net.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink

class TransportPolicyTests {
    @Test fun testOrigin401NeverConsultsGlobalAuthenticatorOrFollowsUp() = withGlobalSpies { spies ->
        for (challenge in listOf("Basic realm=\"fixture\"", "Digest realm=\"fixture\", nonce=\"fixture-nonce\", qop=\"auth\"")) {
            val callbacks = CallbackExecutor()
            WireFixture(reply = { WireReply(401, byteArrayOf(), listOf("WWW-Authenticate" to challenge)) }).use { wire -> wire.client(callbacks = callbacks.executor).use { client ->
                val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
                assertTrue(result.await() is AnonymousDiscoveryOutcome.Failure); callbacks.drain()
                assertEquals(1, wire.requests.size); wire.requests.forEach(::assertAnonymous); spies.assertUnused()
            } }
        }
    }
    private fun connect407(keepAlive: Boolean) = withGlobalSpies { spies ->
        val callbacks = CallbackExecutor()
        WireFixture(tls = false, reply = { WireReply(407, byteArrayOf(), listOf("Proxy-Authenticate" to "Basic realm=\"fixture\""), keepAlive = keepAlive) }).use { proxy ->
            // Separate TLS origin proves a challenged proxy never reaches origin.
            WireFixture().use { origin -> origin.client(proxyPort = proxy.port, callbacks = callbacks.executor).use { client ->
                val result = OutcomeProbe(); client.discover("atelier", result::receive); proxy.awaitRequests()
                assertTrue(result.await() is AnonymousDiscoveryOutcome.Failure); callbacks.drain()
                assertEquals(1, proxy.requests.size); assertEquals("CONNECT", proxy.requests.single().method); assertEquals("core.test:443", proxy.requests.single().target)
                proxy.requests.forEach(::assertAnonymous); assertEquals(0, origin.requests.size); spies.assertUnused()
            } }
        }
    }
    @Test fun testConnect407KeepAliveNeverConsultsGlobalsOrSendsCredentials() = connect407(true)
    @Test fun testConnect407CloseNeverRetriesOrReachesOrigin() = connect407(false)
    @Test fun testOrdinaryProxy407FixedPolicyNeverDelegatesCredentials() = withGlobalSpies { spies ->
        WireFixture(tls = false, reply = { WireReply(407, byteArrayOf(), listOf("Proxy-Authenticate" to "Basic realm=\"fixture\""), keepAlive = true) }).use { proxy ->
            val client = CoreDiscoveryClient.anonymousPolicyForTests(proxy.route(proxy.port), 800)
            assertNotNull("Fixed anonymous policy must exist before component proof", client)
            val actual = requireNotNull(client)
            try {
                val body = object : RequestBody() {
                    override fun contentType() = "application/json".toMediaType()
                    override fun contentLength() = 2L
                    override fun isOneShot() = true
                    override fun writeTo(sink: BufferedSink) { sink.writeUtf8("{}") }
                }
                actual.newCall(Request.Builder().url("http://core.test/api/v1/auth/discover").post(body).build()).execute().use { assertEquals(407, it.code) }
                proxy.awaitRequests(); assertEquals(1, proxy.requests.size); proxy.requests.forEach(::assertAnonymous); spies.assertUnused()
            } finally { actual.dispatcher.executorService.shutdown(); actual.connectionPool.evictAll() }
        }
    }
    @Test fun testCookieHandlerGetAndPutRemainUnused() = withGlobalSpies { spies ->
        WireFixture(reply = { WireReply(headers = Fixtures.headers() + ("Set-Cookie" to "fixture-only=retained; Secure; Path=/")) }).use { wire -> wire.client().use { client ->
            repeat(2) { val result = OutcomeProbe(); client.discover("atelier", result::receive); result.await() }
            wire.awaitRequests(2); wire.requests.forEach(::assertAnonymous); spies.assertUnused()
        } }
        for (status in listOf(400, 302)) WireFixture(reply = { WireReply(status, Fixtures.problem(), Fixtures.headers(true) + ("Set-Cookie" to "fixture-only=retained; Secure") + ("Location" to "https://other.test/")) }).use { wire -> wire.client().use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests(); result.await(); spies.assertUnused()
        } }
    }
    @Test fun testResponseCacheGetAndPutRemainUnused() = withGlobalSpies { spies ->
        WireFixture(reply = { WireReply(headers = Fixtures.headers() + ("ETag" to "fixture-etag") + ("Expires" to "Thu, 31 Dec 2099 23:59:59 GMT")) }).use { wire -> wire.client().use { client ->
            repeat(2) { val result = OutcomeProbe(); client.discover("atelier", result::receive); result.await() }
            wire.awaitRequests(2); assertEquals(2, wire.requests.size); wire.requests.forEach(::assertAnonymous); spies.assertUnused()
        } }
    }
    @Test fun testEveryRedirectOpensNoLocation() {
        for (status in listOf(301, 302, 303, 307, 308)) WireFixture(reply = { WireReply(status, byteArrayOf(), listOf("Location" to "https://core.test/forbidden")) }).use { wire ->
            val callbacks = CallbackExecutor()
            wire.client(callbacks = callbacks.executor).use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
            assertTrue(result.await() is AnonymousDiscoveryOutcome.Failure); callbacks.drain(); assertEquals(1, wire.requests.size)
        } }
    }
    @Test fun testOneShotPostNeverReplaysOnStatusOrConnectionFailure() {
        for (status in listOf(408, 503, 421, -1)) WireFixture(reply = { WireReply(if (status < 0) 200 else status, byteArrayOf(), listOf("Retry-After" to "0"), drop = status < 0) }).use { wire ->
            val callbacks = CallbackExecutor()
            wire.client(callbacks = callbacks.executor).use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
            assertTrue(result.await() is AnonymousDiscoveryOutcome.Failure); callbacks.drain(); assertEquals("One actual request per explicit call", 1, wire.requests.size); assertEquals("One actual POST body write per explicit call", 1, wire.requests.count { it.body.isNotEmpty() })
        } }
    }
    @Test fun testGlobalSpiesDetectDeliberateUrlConnectionDelegation() = withGlobalSpies { spies ->
        WireFixture(tls = false, reply = { if (it.headers.containsKey("authorization")) WireReply(body = byteArrayOf()) else WireReply(401, byteArrayOf(), listOf("WWW-Authenticate" to "Basic realm=\"calibration\"")) }).use { wire ->
            val connection = URI("http://127.0.0.1:${wire.port}/calibration").toURL().openConnection() as HttpURLConnection
            try { connection.useCaches = false; connection.connectTimeout = 600; connection.readTimeout = 600
                runCatching { connection.inputStream.use { it.readBytes() } }
            } finally { connection.disconnect() }
            wire.awaitRequests(); assertTrue("Useful global authenticator sentinel must be observable", spies.serverAuth.get() > 0)
            assertTrue("CookieHandler get calibration", spies.cookieGet.get() > 0); assertTrue("CookieHandler put calibration", spies.cookiePut.get() > 0)
        }
        // A deliberately cache-enabled URLConnection must observe the cache sentinel.
        val cached = URI("http://127.0.0.1:1/cache-calibration").toURL().openConnection()
        cached.connectTimeout = 200; cached.readTimeout = 200; runCatching { cached.getInputStream().use { it.readBytes() } }
        assertTrue("ResponseCache get calibration", spies.cacheGet.get() > 0)
        WireFixture(tls = false, reply = { WireReply(headers = listOf("Content-Type" to "application/json", "Cache-Control" to "public, max-age=600")) }).use { wire ->
            val writing = URI("http://127.0.0.1:${wire.port}/cache-write-calibration").toURL().openConnection()
            writing.connectTimeout = 600; writing.readTimeout = 600; writing.useCaches = true
            writing.getInputStream().use { it.readBytes() }; wire.awaitRequests()
            assertTrue("ResponseCache put calibration", spies.cachePut.get() > 0)
        }
    }
    @Test fun testAttemptCountersDetectDeliberatelyUnsafeFixtureClient() {
        WireFixture(tls = false, reply = { request -> if (request.target == "/unsafe") WireReply(302, byteArrayOf(), listOf("Location" to "/followed")) else WireReply(body = byteArrayOf()) }).use { wire ->
            val deliberatelyUnsafe = OkHttpClient.Builder().followRedirects(true).build()
            try { deliberatelyUnsafe.newCall(Request.Builder().url("http://127.0.0.1:${wire.port}/unsafe").post("{}".toRequestBody()).build()).execute().use { assertEquals(200, it.code) }
                wire.awaitRequests(2); assertEquals(listOf("/unsafe", "/followed"), wire.requests.map { it.target })
            } finally { deliberatelyUnsafe.dispatcher.executorService.shutdown(); deliberatelyUnsafe.connectionPool.evictAll() }
        }
    }
}

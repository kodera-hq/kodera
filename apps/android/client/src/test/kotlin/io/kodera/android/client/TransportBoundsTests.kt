package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch

class TransportBoundsTests {
    private fun run(response: WireReply): AnonymousDiscoveryOutcome = WireFixture(reply = { response }).use { wire -> wire.client().use { client ->
        val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests(); result.await()
    } }
    @Test fun testDeclaredOversizeRefusesBeforeReadingBody() {
        val bodyGate = CountDownLatch(1)
        WireFixture(reply = { WireReply(body = byteArrayOf(), declaredLength = 65537, afterHeaders = bodyGate) }).use { wire -> wire.client().use { client ->
            try { val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
                assertEquals("Header refusal cannot wait for body delivery", AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), result.await(500))
            } finally { bodyGate.countDown() }
        } }
    }
    @Test fun testChunkedLimitPlusOneCancelsBeforeExcessAppend() {
        val data = Fixtures.data("zero"); val excess = data + ByteArray(65537 - data.size) { 32 }
        assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), run(WireReply(body = excess, chunked = true)))
    }
    @Test fun testExactBodyLimitAccepted() {
        val data = Fixtures.data("zero"); val exact = data + ByteArray(65536 - data.size) { 32 }
        assertEquals(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), run(WireReply(body = exact, chunked = true)))
    }
    @Test fun testMalformedUtf8AndContentEncodingRefuse() {
        assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), run(WireReply(body = byteArrayOf(0xff.toByte()))))
        for (encoding in listOf("gzip", "br", "unknown")) assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), run(WireReply(headers = Fixtures.headers() + ("Content-Encoding" to encoding))))
    }
    @Test fun testSecurityHeadersMediaAndStatusAreValidated() {
        for (headers in listOf(Fixtures.headers() + ("X-Request-Id" to "different"), Fixtures.headers().filterNot { it.first == "Cache-Control" }, Fixtures.headers().filterNot { it.first == "Content-Type" } + ("Content-Type" to "text/html"), Fixtures.headers().map { if (it.first == "X-Request-Id") it.first to "a".repeat(65) else it })) {
            assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), run(WireReply(headers = headers)))
        }
    }
    @Test fun testReadDeadlineOfflineAndNormalTlsRefusalStayUnavailable() {
        val hold = CountDownLatch(1)
        // A held reply runs out the 150 ms step timeout. The call's own timeout is separate and longer, so a
        // cold first handshake cannot use up the call before the request reaches the fixture.
        WireFixture(reply = { WireReply(hold = hold) }).use { wire -> wire.client(150, callTimeoutMillis = Fixtures.COLD_START_MILLIS).use { client ->
            try { val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests()
                assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(TransportFailure.TIMEOUT)), result.await())
            } finally { hold.countDown() }
        } }
        // No test trust supplied: a self-signed fixture must never become production success.
        WireFixture().use { wire -> CoreDiscoveryClient(Fixtures.configuration(), wire.route(), 500, usePlatformTrustForTest = true).use { client ->
            val result = OutcomeProbe(); client.discover("atelier", result::receive)
            assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(TransportFailure.TLS)), result.await()); assertEquals(0, wire.requests.size)
        } }
        WireFixture().use { wire -> val route = wire.route(); wire.close()
            CoreDiscoveryClient(Fixtures.configuration(), route, 300).use { client -> val result = OutcomeProbe(); client.discover("atelier", result::receive)
                assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(TransportFailure.OFFLINE)), result.await()) }
        }
    }
}

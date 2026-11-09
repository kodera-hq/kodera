package io.kodera.android.client

import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.LoopbackPolicy
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class RevocationTests {
    private val issuer = IssuerAdmission.admit("https://core.test/realms/acme-sa", setOf("https://core.test"), LoopbackPolicy.REFUSE)
    private val endpoint = "https://core.test/realms/acme-sa/protocol/openid-connect/revoke"

    @Test fun testRevocationGoesOnlyToTheIssuerOrigin() {
        for (other in listOf("https://evil.test/revoke", "https://core.test.evil/revoke", "https://core.test:444/revoke",
                "http://core.test/revoke", "https://core.test", "https://core.test/a@evil.test")) {
            assertNull(other, Revocation.request(other, "refresh-1", "kodera-android", issuer))
        }
    }

    @Test fun testTheRequestIsAnRfc7009PublicClientForm() {
        val request = checkNotNull(Revocation.request(endpoint, "refresh 1&x=y", "kodera-android", issuer))
        assertEquals("POST", request.method)
        assertEquals(endpoint, request.url.toString())
        val body = Buffer().also { checkNotNull(request.body).writeTo(it) }.readUtf8()
        // application/x-www-form-urlencoded: a space is "+", reserved characters are escaped.
        assertEquals("token=refresh+1%26x%3Dy&token_type_hint=refresh_token&client_id=kodera-android", body)
        assertEquals("application/x-www-form-urlencoded", checkNotNull(request.body).contentType().toString())
        assertNull("no client secret, no bearer", request.header("Authorization"))
    }

    @Test fun testSendReachesTheEndpointAndNeverThrows() {
        WireFixture(reply = { WireReply(200, ByteArray(0), emptyList()) }).use { wire ->
            Revocation.send(checkNotNull(Revocation.request(endpoint, "refresh-1", "kodera-android", issuer)), wire.route(), 2000)
            wire.awaitRequests()
            val recorded = wire.requests.single()
            assertEquals("/realms/acme-sa/protocol/openid-connect/revoke", recorded.target)
            assertEquals("token=refresh-1&token_type_hint=refresh_token&client_id=kodera-android", recorded.body.toString(Charsets.UTF_8))
        }
        // Nothing listens: still no exception.
        val closed = WireFixture().use { it.route() }
        Revocation.send(checkNotNull(Revocation.request(endpoint, "refresh-1", "kodera-android", issuer)), closed, 500)
    }

    @Test fun testDiscoveredEndpointsMustNameTheIssuerAndStayOnItsOrigin() {
        val base = "https://core.test/realms/acme-sa/protocol/openid-connect"
        DiscoveredEndpoints.check(issuer.issuer, "$base/auth", "$base/token", issuer)
        val refused = listOf(
            Triple(null, "$base/auth", "$base/token"),
            Triple("https://core.test/realms/other-org", "$base/auth", "$base/token"),
            Triple("${issuer.issuer}/", "$base/auth", "$base/token"),
            Triple(issuer.issuer, "https://evil.test/auth", "$base/token"),
            Triple(issuer.issuer, "$base/auth", "https://core.test:8443/token"),
            Triple(issuer.issuer, "$base/auth", "http://core.test/token"),
        )
        for ((documentIssuer, authorization, token) in refused) {
            try {
                DiscoveredEndpoints.check(documentIssuer, authorization, token, issuer)
                fail("$documentIssuer $authorization $token")
            } catch (error: BackendException) { assertEquals(BackendFailure.PROTOCOL_VIOLATION, error.failure) }
        }
    }
}

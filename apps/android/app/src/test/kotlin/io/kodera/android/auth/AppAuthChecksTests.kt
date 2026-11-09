package io.kodera.android.auth

import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** Built from parts: app sources, tests included, carry no endpoint literal (check-app-resources.py). */
internal fun url(scheme: String, rest: String): String = scheme + "://" + rest

/** The failure [block] refused with, or null when it accepted. */
private fun refusal(block: () -> Unit): BackendFailure? =
    try { block(); null } catch (error: BackendException) { error.failure }

class AppAuthChecksTests {
    private val issuer = url(ConnectionPolicy.HTTPS, "id.kodera.test/realms/acme-sa")

    // PKCE

    @Test fun testOnlyS256IsAccepted() {
        assertNull(refusal { AppAuthChecks.requireS256("S256") })
        for (method in listOf("plain", "s256", "", null)) {
            assertEquals("$method", BackendFailure.PROTOCOL_VIOLATION, refusal { AppAuthChecks.requireS256(method) })
        }
    }

    // the browser's answer: state and RFC 9207

    private fun answer(returnedState: String? = "state-1", iss: String? = issuer, supported: Boolean = true,
        expectedState: String? = "state-1") = refusal {
        AppAuthChecks.checkAuthorizationResponse(expectedState, returnedState, iss, issuer, supported)
    }

    @Test fun testAMatchingAnswerIsAccepted() {
        assertNull(answer())
        assertNull("iss present though not advertised", answer(supported = false))
    }

    @Test fun testAnotherStateIsRefused() {
        assertEquals(BackendFailure.PROTOCOL_VIOLATION, answer(returnedState = "state-2"))
        assertEquals(BackendFailure.PROTOCOL_VIOLATION, answer(returnedState = null))
        assertEquals("a request without state is never matched", BackendFailure.PROTOCOL_VIOLATION,
            answer(returnedState = null, expectedState = null))
    }

    @Test fun testIssIsRequiredWhenDiscoveryAdvertisesIt() {
        assertEquals(BackendFailure.PROTOCOL_VIOLATION, answer(iss = null, supported = true))
        assertNull("not advertised: an absent iss is accepted", answer(iss = null, supported = false))
    }

    @Test fun testAPresentIssMustBeTheAdmittedIssuer() {
        for (other in listOf(url(ConnectionPolicy.HTTPS, "id.kodera.test/realms/other-org"), "$issuer/",
                url(ConnectionPolicy.HTTPS, "evil.test/realms/acme-sa"), "")) {
            assertEquals(other, BackendFailure.PROTOCOL_VIOLATION, answer(iss = other, supported = true))
            assertEquals(other, BackendFailure.PROTOCOL_VIOLATION, answer(iss = other, supported = false))
        }
    }

    @Test fun testOnlyAJsonTrueAdvertisesTheIssParameter() {
        assertTrue(AppAuthChecks.advertisesIssuerParameter(true))
        for (value in listOf(false, "true", 1, null)) assertFalse("$value", AppAuthChecks.advertisesIssuerParameter(value))
    }

    // the code exchange

    @Test fun testTheExchangeNeedsAnAuthorizedStateAnAccessTokenAndAnIdToken() {
        assertNull(refusal { AppAuthChecks.checkTokenResponse(true, "access", "id") })
        assertEquals(BackendFailure.REFUSED, refusal { AppAuthChecks.checkTokenResponse(false, "access", "id") })
        assertEquals(BackendFailure.REFUSED, refusal { AppAuthChecks.checkTokenResponse(true, null, "id") })
        assertEquals("no ID token: AppAuth's nonce check never ran", BackendFailure.PROTOCOL_VIOLATION,
            refusal { AppAuthChecks.checkTokenResponse(true, "access", null) })
    }

    // HTTPS and loopback

    @Test fun testAppAuthsIssuerHttpsCheckIsSkippedOnlyWhereLoopbackIsAdmitted() {
        assertFalse(AppAuthChecks.skipIssuerHttpsCheck(LoopbackPolicy.REFUSE))
        assertTrue(AppAuthChecks.skipIssuerHttpsCheck(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT))
    }

    @Test fun testConnectionPolicy() {
        val admit = LoopbackPolicy.ADMIT_FOR_DEVELOPMENT
        assertTrue(ConnectionPolicy.admits("https", "id.kodera.test", LoopbackPolicy.REFUSE))
        assertTrue(ConnectionPolicy.admits("https", "id.kodera.test", admit))
        assertFalse("plain HTTP loopback in a release", ConnectionPolicy.admits("http", "localhost:8080", LoopbackPolicy.REFUSE))
        assertTrue(ConnectionPolicy.admits("http", "localhost:8080", admit))
        assertTrue(ConnectionPolicy.admits("http", "127.0.0.1:8080", admit))
        for (authority in listOf("localhost.evil.test:8080", "user@localhost:8080", "localhost", "localhost:0",
                "localhost:65536", "id.kodera.test", "10.0.2.2:8080", null)) {
            assertFalse("$authority", ConnectionPolicy.admits("http", authority, admit))
        }
        for (scheme in listOf("HTTP", "ftp", "file", null)) assertFalse("$scheme", ConnectionPolicy.admits(scheme, "localhost:8080", admit))
    }

    @Test fun testConnectionsFollowNoRedirectAndCacheNothing() {
        val connection = LoopbackAwareConnections(LoopbackPolicy.REFUSE).open(url("https", "id.kodera.test/realms/acme-sa"))
        assertFalse("a redirect could carry a code or a token off the origin", connection.instanceFollowRedirects)
        assertFalse(connection.useCaches)
        assertEquals(LoopbackAwareConnections.TIMEOUT_MILLIS, connection.connectTimeout)
        assertEquals(LoopbackAwareConnections.TIMEOUT_MILLIS, connection.readTimeout)
    }

    @Test fun testConnectionsRefusePlainHttpBeforeOpeningUnlessLoopbackIsAdmitted() {
        val local = url("http", "localhost:8080/realms/kodera-dev")
        assertThrows(IOException::class.java) { LoopbackAwareConnections(LoopbackPolicy.REFUSE).open(local) }
        assertThrows(IOException::class.java) {
            LoopbackAwareConnections(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT).open(url("http", "core.kodera.test/x"))
        }
        assertThrows(IOException::class.java) { LoopbackAwareConnections(LoopbackPolicy.REFUSE).open("not a url") }
        assertFalse(LoopbackAwareConnections(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT).open(local).instanceFollowRedirects)
    }

    // the stored state

    @Test fun testAnUnreadableStoredStateIsNullNotACrash() {
        assertEquals("state", AppAuthChecks.decodeOrNull("json") { "state" })
        // What AppAuth's preconditions throw from jsonDeserialize. (JSONException is caught too; the
        // host's android.jar cannot construct one.)
        for (thrown in listOf(IllegalArgumentException("checkNotEmpty"), IllegalStateException("checkState"),
                NullPointerException("checkNotNull"))) {
            assertNull(thrown.javaClass.simpleName, AppAuthChecks.decodeOrNull<String>("json") { throw thrown })
        }
        // Anything else is a bug, not a stored state to wipe: it still surfaces.
        assertThrows(UnsupportedOperationException::class.java) {
            AppAuthChecks.decodeOrNull<String>("json") { throw UnsupportedOperationException() }
        }
    }

    // a refresh that answered late

    @Test fun testALateRotationIsKeptForItsGrantOnly() {
        val rotations = LateRotations()
        assertNull(rotations.peek("grant-1"))
        rotations.record("grant-1", "rotated-1")
        assertEquals("rotated-1", rotations.peek("grant-1"))
        assertNull("another grant does not see it", rotations.peek("grant-2"))
        rotations.clear("grant-2")
        assertEquals("clearing another grant leaves it", "rotated-1", rotations.peek("grant-1"))
        rotations.record("grant-1", "rotated-2")
        assertEquals("the latest answer wins", "rotated-2", rotations.peek("grant-1"))
        rotations.clear("grant-1")
        assertNull(rotations.peek("grant-1"))
    }

    /** Signed out: a late rotation of that grant is neither kept nor revoked (only sign-out revokes). */
    @Test fun testALateRotationOfASignedOutGrantIsDropped() {
        val rotations = LateRotations()
        rotations.record("grant-1", "rotated-1")
        rotations.retire("grant-1")
        assertNull("its slot goes with it", rotations.peek("grant-1"))
        rotations.record("grant-1", "rotated-2")
        assertNull("never kept", rotations.peek("grant-1"))
        rotations.record("grant-2", "rotated-3")
        assertEquals("another grant's late answer is kept as before", "rotated-3", rotations.peek("grant-2"))
    }
}

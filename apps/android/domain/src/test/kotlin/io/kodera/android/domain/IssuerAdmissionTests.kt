package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IssuerAdmissionTests {
    private val origins = setOf("https://auth.kodera.test")

    private fun refusedWith(code: DomainError, label: String, block: () -> Unit) {
        try { block(); fail("accepted: $label") } catch (error: DomainFailure) { assertEquals(label, code, error.code) }
    }

    @Test fun testOnlyTheDevelopmentPolicyAdmitsLoopback() {
        assertTrue(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT.admitsLoopback)
        assertFalse(LoopbackPolicy.REFUSE.admitsLoopback)
    }

    @Test fun testExactConfiguredOriginAndRealmIsAdmitted() {
        val admitted = IssuerAdmission.admit("https://auth.kodera.test/realms/acme-sa", origins, LoopbackPolicy.REFUSE)
        assertEquals("https://auth.kodera.test/realms/acme-sa", admitted.issuer)
        assertEquals("https://auth.kodera.test", admitted.origin)
        assertEquals("acme-sa", admitted.realm)
    }

    @Test fun testAnyOtherIssuerShapeIsRefused() {
        val refused = listOf(
            "https://auth.kodera.test.evil/realms/acme-sa",
            "https://evil.test/realms/acme-sa",
            "https://auth.kodera.test:8443/realms/acme-sa",
            "https://user@auth.kodera.test/realms/acme-sa",
            "http://auth.kodera.test/realms/acme-sa",
            "HTTPS://auth.kodera.test/realms/acme-sa",
            "https://auth.kodera.test/realms/acme-sa/",
            "https://auth.kodera.test/realms/acme-sa/extra",
            "https://auth.kodera.test/realms/ACME-SA",
            "https://auth.kodera.test/realms/acme%2Dsa",
            "https://auth.kodera.test/realms/acme-sa?x=1",
            "https://auth.kodera.test/realms/acme-sa#x",
            "https://auth.kodera.test/realms/abc",
            "https://auth.kodera.test/realms/",
            "https://auth.kodera.test/auth/realms/acme-sa",
            "",
        )
        for (issuer in refused) {
            refusedWith(DomainError.UNTRUSTED_ISSUER, issuer) {
                IssuerAdmission.admit(issuer, origins, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
            }
        }
    }

    @Test fun testNoConfiguredOriginAdmitsNothing() {
        refusedWith(DomainError.UNTRUSTED_ISSUER, "empty") {
            IssuerAdmission.admit("https://auth.kodera.test/realms/acme-sa", emptySet(), LoopbackPolicy.REFUSE)
        }
    }

    @Test fun testLoopbackOriginIsAdmittedOnlyForDevelopment() {
        val local = setOf("http://localhost:8080")
        val issuer = "http://localhost:8080/realms/kodera-dev"
        refusedWith(DomainError.INVALID_ORIGIN, "refuse policy") { IssuerAdmission.admit(issuer, local, LoopbackPolicy.REFUSE) }
        assertEquals("kodera-dev", IssuerAdmission.admit(issuer, local, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT).realm)
        // The configured port only: another local listener is a different origin.
        refusedWith(DomainError.UNTRUSTED_ISSUER, "other port") {
            IssuerAdmission.admit("http://localhost:8081/realms/kodera-dev", local, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
        }
    }

    @Test fun testOnlyExactLoopbackFormsPassOverHttp() {
        for (value in listOf("http://localhost:8080", "http://127.0.0.1:1", "http://localhost:65535")) {
            IssuerAdmission.validateOrigin(value, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
        }
        for (value in listOf("http://localhost", "http://localhost:", "http://localhost:0", "http://localhost:08080",
                "http://localhost:65536", "http://localhost:8080/", "http://localhost.evil.test:8080",
                "http://127.0.0.2:8080", "http://[::1]:8080", "http://10.0.2.2:8080", "http://auth.kodera.test",
                "http://localhost:80a", "https://localhost:8080", "https://auth.kodera.test/")) {
            refusedWith(DomainError.INVALID_ORIGIN, value) { IssuerAdmission.validateOrigin(value, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT) }
        }
        refusedWith(DomainError.INVALID_ORIGIN, "refuse") { IssuerAdmission.validateOrigin("http://localhost:8080", LoopbackPolicy.REFUSE) }
    }

    @Test fun testEndpointsMustShareTheIssuerOrigin() {
        val admitted = IssuerAdmission.admit("https://auth.kodera.test/realms/acme-sa", origins, LoopbackPolicy.REFUSE)
        assertTrue(IssuerAdmission.sharesOrigin("https://auth.kodera.test/realms/acme-sa/protocol/openid-connect/revoke", admitted))
        for (url in listOf("https://auth.kodera.test.evil/revoke", "https://evil.test/revoke",
                "https://auth.kodera.test:444/revoke", "http://auth.kodera.test/revoke",
                "https://auth.kodera.test", "https://auth.kodera.test/a@evil.test",
                "https://auth.kodera.test/a\\b", "https://auth.kodera.test/a b")) {
            assertFalse(url, IssuerAdmission.sharesOrigin(url, admitted))
        }
    }
}

class DiscoveryLoopbackTests {
    @Test fun testDiscoveryUsesTheSameValidatorAndAdmitsLoopbackOnlyForDevelopment() {
        try {
            DiscoveryTrust.configured("http://localhost:8000", setOf("http://localhost:8080"))
            fail("a release build admitted a loopback Core origin")
        } catch (error: DomainFailure) { assertEquals(DomainError.INVALID_ORIGIN, error.code) }
        val trust = DiscoveryTrust.configured("http://localhost:8000", setOf("http://localhost:8080"), LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
        val selection = DiscoverySelection("6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f", "kodera-dev", "kodera-dev",
            "http://localhost:8080/realms/kodera-dev", "http://localhost:8080/realms/kodera-dev/.well-known/openid-configuration")
        assertEquals(selection, TrustPolicy.validateDiscovery(selection, trust).selection)
        for (origin in listOf("http://10.0.2.2:8080", "http://localhost.evil.test:8080", "http://core.test")) {
            try {
                DiscoveryTrust.configured("http://localhost:8000", setOf(origin), LoopbackPolicy.ADMIT_FOR_DEVELOPMENT)
                fail(origin)
            } catch (error: DomainFailure) { assertEquals(origin, DomainError.INVALID_ORIGIN, error.code) }
        }
    }
}

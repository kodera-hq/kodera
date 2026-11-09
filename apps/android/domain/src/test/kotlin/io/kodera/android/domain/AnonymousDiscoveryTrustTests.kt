package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

/** Anonymous metadata acceptance; these synthetic values prove no transport or identity. */
class AnonymousDiscoveryTrustTests {
    private fun trust() = DiscoveryTrust.configured("https://core.test", setOf("https://identity.test"))

    @Test fun anonymousDiscoveryNeedsOnlyProtectedCoreAndIssuerTrust() {
        val input = Fixtures.discovery()
        val metadata = succeeds("anonymous discovery must not require a native identity profile") {
            TrustPolicy.validateDiscovery(input, trust())
        }
        assertEquals(input, metadata.selection)
        assertEquals(Fixtures.organisation, metadata.selection.organisationId)
        assertEquals("atelier", metadata.selection.organisationSlug)
        assertEquals("atelier", metadata.selection.realm)
        assertEquals(Fixtures.issuer, metadata.selection.issuer)
        assertEquals("${Fixtures.issuer}/.well-known/openid-configuration", metadata.selection.openidConfigurationUrl)
    }

    @Test fun anonymousDiscoveryPreservesLeadingDigitOrganisation() {
        val input = Fixtures.discovery(slug = "1team", realm = "1team",
            issuer = "https://identity.test/realms/1team")
        assertEquals(input, succeeds("leading-digit anonymous discovery must preserve exact metadata") {
            TrustPolicy.validateDiscovery(input, trust())
        }.selection)
    }

    @Test fun anonymousTrustRejectsMalformedOriginProfiles() {
        for (origin in listOf(
            "http://core.test", "HTTPS://core.test", "https://Core.test", "https://user@core.test",
            "https://core.test:443", "https://core.test/path", "https://core%2etest",
            "https://core.test/../", "https://core.test?x", "https://core.test#x",
            "https://core.test\n", "https://core.test\t", "https://core.test\\evil",
            "https://127.0.0.1", "https://0x7f.1", "https://0x7f.0x0.0x0.0x1"
        )) refuses(DomainError.INVALID_ORIGIN, "protected Core origin: $origin") {
            DiscoveryTrust.configured(origin, setOf("https://identity.test"))
        }
        for (origin in listOf(
            "http://identity.test", "https://Identity.test", "https://identity.test:443",
            "https://identity.test/realms/atelier", "https://identity%2etest",
            "https://identity.test\n", "https://user@identity.test", "https://0x7f.1"
        )) refuses(DomainError.INVALID_ORIGIN, "protected issuer origin: $origin") {
            DiscoveryTrust.configured("https://core.test", setOf(origin))
        }
        refuses(DomainError.UNTRUSTED_ISSUER, "empty protected issuer set") {
            DiscoveryTrust.configured("https://core.test", emptySet())
        }
        refuses(DomainError.UNTRUSTED_ISSUER, "issuer origin must not carry a trailing slash") {
            DiscoveryTrust.configured("https://core.test", setOf("https://identity.test/"))
        }
    }

    @Test fun anonymousDiscoveryRefusesMalformedOrUnboundSelection() {
        val refused = listOf(
            Fixtures.discovery(organisationId = "invalid") to DomainError.INVALID_ORGANISATION,
            Fixtures.discovery(slug = "ATELIER", realm = "ATELIER") to DomainError.INVALID_SLUG,
            Fixtures.discovery(slug = "tiny", realm = "tiny") to DomainError.INVALID_SLUG,
            Fixtures.discovery(realm = "other") to DomainError.MISMATCHED_REALM,
            Fixtures.discovery(issuer = "https://identity.test.evil/realms/atelier") to DomainError.UNTRUSTED_ISSUER,
            Fixtures.discovery(issuer = "https://other.test/realms/atelier") to DomainError.UNTRUSTED_ISSUER,
            Fixtures.discovery(issuer = "https://identity.test/realms/%61telier") to DomainError.UNTRUSTED_ISSUER,
            Fixtures.discovery(issuer = "https://identity.test/realms/atelier\n") to DomainError.UNTRUSTED_ISSUER,
            Fixtures.discovery(issuer = "https://identity.test:443/realms/atelier") to DomainError.UNTRUSTED_ISSUER,
            Fixtures.discovery(wellKnown = "https://identity.test/other") to DomainError.MISMATCHED_WELL_KNOWN,
        )
        for ((selection, expected) in refused) refuses(expected, selection.toString()) {
            TrustPolicy.validateDiscovery(selection, trust())
        }
    }

    @Test fun anonymousTrustSnapshotsCallerIssuerSet() {
        val supplied = mutableSetOf("https://identity.test")
        val configured = DiscoveryTrust.configured("https://core.test", supplied)
        supplied.clear()
        supplied.add("https://foreign.test")
        assertEquals(Fixtures.discovery(), succeeds("caller mutation must not replace protected issuer trust") {
            TrustPolicy.validateDiscovery(Fixtures.discovery(), configured)
        }.selection)
        refuses(DomainError.UNTRUSTED_ISSUER, "caller mutation must not expand protected issuer trust") {
            TrustPolicy.validateDiscovery(Fixtures.discovery(issuer = "https://foreign.test/realms/atelier"), configured)
        }
    }

    @Test fun fullEnvironmentStillRequiresNativeIdentityClient() {
        for (client in listOf("", " ", "test-client\n")) {
            val incomplete = Fixtures.environment.copy(nativeClientId = client, redirectUri = "", matrixRedirectUri = "")
            refuses(DomainError.UNSUPPORTED_CONTRACT) {
                TrustPolicy.validateDiscovery(Fixtures.discovery(), incomplete)
            }
        }
        assertEquals(Fixtures.discovery(), succeeds {
            TrustPolicy.validateDiscovery(Fixtures.discovery(), Fixtures.environment)
        }.selection)
    }

    @Test fun coreAndMatrixEmptyOrMergedCallbacksStillRefuse() {
        val absent = Fixtures.environment.copy(nativeClientId = "", redirectUri = "", matrixRedirectUri = "")
        val sharedCallback = "io.kodera.app:/shared/oauth2redirect"
        val merged = Fixtures.environment.copy(redirectUri = sharedCallback, matrixRedirectUri = sharedCallback)
        for (hop in CallbackHop.entries) {
            refuses(DomainError.CALLBACK_MISMATCH) { TrustPolicy.validateCallback("", hop, absent) }
            refuses(DomainError.CALLBACK_MISMATCH) { TrustPolicy.validateCallback(sharedCallback, hop, merged) }
        }
        refuses(DomainError.CALLBACK_MISMATCH) {
            TrustPolicy.validateCallback(Fixtures.environment.matrixRedirectUri, CallbackHop.CORE, Fixtures.environment)
        }
        succeeds { TrustPolicy.validateCallback(Fixtures.environment.redirectUri, CallbackHop.CORE, Fixtures.environment) }
        succeeds { TrustPolicy.validateCallback(Fixtures.environment.matrixRedirectUri, CallbackHop.MATRIX, Fixtures.environment) }
    }
}

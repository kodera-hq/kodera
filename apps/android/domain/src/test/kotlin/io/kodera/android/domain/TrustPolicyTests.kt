package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

// Reserved synthetic values only. No endpoint, credential or authenticated adapter exists.
internal object Fixtures {
    const val organisation = "11111111-1111-4111-8111-111111111111"
    const val channel = "22222222-2222-4222-8222-222222222222"
    const val otherOrganisation = "33333333-3333-4333-8333-333333333333"
    const val issuer = "https://identity.test/realms/atelier"
    val environment = EnvironmentTrust(
        "https://core.test", setOf("https://identity.test"), "test.kodera.android",
        "io.kodera.app:/oauth2redirect", "io.kodera.app:/matrix/oauth2redirect"
    )
    fun discovery(
        organisationId: String = organisation, slug: String = "atelier", realm: String = "atelier",
        issuer: String = Fixtures.issuer, wellKnown: String = "$issuer/.well-known/openid-configuration"
    ) = DiscoverySelection(organisationId, slug, realm, issuer, wellKnown)
    fun core(subject: String = "member-1", organisationId: String = organisation,
             issuer: String = Fixtures.issuer) = CoreIdentity(organisationId, issuer, subject)
    fun descriptor(
        schema: Int? = 1, organisationId: String = organisation, server: String = "atelier.test",
        homeserver: String = "https://matrix.test", rooms: String = "https://rooms.test",
        readiness: ServiceReadiness? = ServiceReadiness.Ready
    ) = CollaborationDescriptor(schema, organisationId, server, homeserver, rooms, readiness)
    fun provenance(
        origin: String = "https://core.test", organisationId: String = organisation,
        issuer: String = Fixtures.issuer, subject: String = "member-1"
    ): DescriptorProvenance = DescriptorProvenance.AuthenticatedCore(origin, organisationId, issuer, subject)
    fun validatedDiscovery() = TrustPolicy.validateDiscovery(discovery(), environment)
    fun validatedDescriptor(
        readiness: ServiceReadiness = ServiceReadiness.Ready, coreIdentity: CoreIdentity = core()
    ) = TrustPolicy.validateDescriptor(
        descriptor(readiness = readiness), validatedDiscovery(), coreIdentity, environment,
        provenance(organisationId = coreIdentity.organisationId, issuer = coreIdentity.issuer,
            subject = coreIdentity.subject)
    )
}

internal fun <T> succeeds(message: String = "expected successful local behavior", action: () -> T): T =
    try { action() } catch (failure: Throwable) { throw AssertionError(message, failure) }

internal fun refuses(expected: DomainError? = null, message: String = "expected local refusal", action: () -> Unit) {
    try {
        action()
    } catch (failure: DomainFailure) {
        if (expected != null) assertEquals(message, expected, failure.code)
        return
    }
    fail(message)
}

class TrustPolicyTests {
    @Test fun approvedDiscoveryPreservesExactValuesWithoutLogin() {
        val value = succeeds { Fixtures.validatedDiscovery() }
        assertEquals(Fixtures.discovery(), value.selection)
    }

    @Test fun originProfileRejectsAmbiguousOrInsecureInput() {
        val refused = listOf(
            "http://core.test", "HTTPS://core.test", "https://Core.test", "https://core.test:443",
            "https://core.test:8443", "https://core.test:", "https://core.test:no", "https://user@core.test",
            "https://core.test/path", "https://core.test?query", "https://core.test#fragment",
            "https://core%2etest", "https://core.test/%2f", "https://core.test/../",
            "https://core.test\\evil", "https://", "https://-bad.test", "https://bad..test",
            "https://127.0.0.1", "https://core.test.", " https://core.test", "https://core.test\n",
            "https://core.test\t", "https://core.\ntest", "https://core.test\r"
        )
        for (value in refused) refuses(DomainError.INVALID_ORIGIN, value) { TrustPolicy.validateOrigin(value) }
        succeeds { TrustPolicy.validateOrigin("https://core.test") }
        succeeds { TrustPolicy.validateOrigin("https://core.test/") }
    }

    @Test fun issuerMustMatchExactAdmittedOriginAndRealmPath() {
        for (issuer in listOf(
            "https://identity.test.evil/realms/atelier", "https://other.test/realms/atelier",
            "https://identity.test:443/realms/atelier", "https://identity.test/realms/other",
            "https://identity.test/realms/atelier/", "https://identity.test/realms/%61telier",
            "https://identity.test/realms/atelier?x", "https://identity.test/realms/atelier#x",
            "https://identity.test/realms/atelier\n", "https://identity.test/realms/atelier\t"
        )) refuses(message = issuer) {
            TrustPolicy.validateDiscovery(Fixtures.discovery(issuer = issuer), Fixtures.environment)
        }
    }

    @Test fun wrongWellKnownRealmSlugAndOrganisationAreRejected() {
        for (selection in listOf(
            Fixtures.discovery(wellKnown = "https://identity.test/other"), Fixtures.discovery(slug = "other"),
            Fixtures.discovery(slug = "ATELIER", realm = "ATELIER"), Fixtures.discovery(slug = "tiny", realm = "tiny"),
            Fixtures.discovery(organisationId = "bad")
        )) refuses { TrustPolicy.validateDiscovery(selection, Fixtures.environment) }
    }

    @Test fun discoveryRequiresExplicitCandidateSelection() {
        assertNull(succeeds { TrustPolicy.selectDiscovery(emptyList(), null, Fixtures.environment) })
        val choices = listOf(Fixtures.discovery(), Fixtures.discovery(organisationId = Fixtures.otherOrganisation))
        refuses(DomainError.SELECTION_REQUIRED) { TrustPolicy.selectDiscovery(choices, null, Fixtures.environment) }
        val selected = succeeds { TrustPolicy.selectDiscovery(choices, Fixtures.organisation, Fixtures.environment) }
        assertEquals(Fixtures.organisation, selected?.selection?.organisationId)
        refuses { TrustPolicy.selectDiscovery(choices, "absent", Fixtures.environment) }
    }

    @Test fun descriptorNeedsTrustedCoreProvenanceAndMatchingIdentity() {
        val discovery = succeeds { Fixtures.validatedDiscovery() }
        for (provenance in listOf(
            DescriptorProvenance.Unverified, Fixtures.provenance(origin = "https://core.test.evil"),
            Fixtures.provenance(organisationId = Fixtures.otherOrganisation),
            Fixtures.provenance(issuer = "https://other.test/realms/atelier"), Fixtures.provenance(subject = "other")
        )) refuses(DomainError.UNTRUSTED_PROVENANCE) {
            TrustPolicy.validateDescriptor(Fixtures.descriptor(), discovery, Fixtures.core(),
                Fixtures.environment, provenance)
        }
        refuses {
            TrustPolicy.validateDescriptor(Fixtures.descriptor(), discovery,
                Fixtures.core(organisationId = Fixtures.otherOrganisation), Fixtures.environment, Fixtures.provenance())
        }
    }

    @Test fun descriptorRejectsUnsupportedSchemaBindingAndUnsafeDestinations() {
        val discovery = succeeds { Fixtures.validatedDiscovery() }
        for (descriptor in listOf(
            Fixtures.descriptor(schema = null), Fixtures.descriptor(schema = 2),
            Fixtures.descriptor(organisationId = Fixtures.otherOrganisation), Fixtures.descriptor(server = "atelier.test:443"),
            Fixtures.descriptor(homeserver = "http://matrix.test"), Fixtures.descriptor(rooms = "https://rooms.test/path"),
            Fixtures.descriptor(readiness = null), Fixtures.descriptor(readiness = ServiceReadiness.Unknown)
        )) refuses {
            TrustPolicy.validateDescriptor(descriptor, discovery, Fixtures.core(), Fixtures.environment, Fixtures.provenance())
        }
    }

    @Test fun pendingAndUnavailableMetadataNeverBecomeReady() {
        for (readiness in listOf(ServiceReadiness.Pending, ServiceReadiness.Unavailable(UnavailabilityReason.SERVICE_UNAVAILABLE))) {
            val descriptor = succeeds { Fixtures.validatedDescriptor(readiness) }
            assertEquals(readiness, descriptor.readiness)
            assertFalse(descriptor.canAttemptConnection)
        }
        assertTrue(succeeds { Fixtures.validatedDescriptor() }.canAttemptConnection)
    }

    @Test fun coreAndMatrixCallbacksHaveIndependentExactProfiles() {
        succeeds { TrustPolicy.validateCallback("io.kodera.app:/oauth2redirect", CallbackHop.CORE, Fixtures.environment) }
        succeeds { TrustPolicy.validateCallback("io.kodera.app:/matrix/oauth2redirect", CallbackHop.MATRIX, Fixtures.environment) }
        for (callback in listOf(
            "io.kodera.app:/oauth2redirect", "io.kodera.app:/matrix/oauth2redirect/",
            "evil:/matrix/callback", "https://matrix.test/_synapse/client/oidc/callback"
        )) refuses(DomainError.CALLBACK_MISMATCH) {
            TrustPolicy.validateCallback(callback, CallbackHop.MATRIX, Fixtures.environment)
        }
    }

    @Test fun leadingDigitOrganisationMatchesCurrentCoreDiscoveryContract() {
        succeeds {
            TrustPolicy.validateDiscovery(Fixtures.discovery(slug = "1team", realm = "1team",
                issuer = "https://identity.test/realms/1team"), Fixtures.environment)
        }
    }

    @Test fun dnsOnlyOriginProfileRejectsLegacyHexadecimalIPv4Forms() {
        for (value in listOf("https://0x7f.1", "https://0x7f.0.0.1", "https://0x7f.0x0.0x0.0x1")) {
            refuses(DomainError.INVALID_ORIGIN, value) { TrustPolicy.validateOrigin(value) }
        }
    }
}

package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

class SessionContextTests {
    private fun matrix(user: String = "@member-1:atelier.test", device: String = "device-a",
                       homeserver: String = "https://matrix.test") = MatrixIdentity(user, device, homeserver)
    private fun bind(core: CoreIdentity = Fixtures.core(), matrix: MatrixIdentity = matrix(), generation: Long = 1) =
        AccountContext.bind(Fixtures.validatedDiscovery(), Fixtures.validatedDescriptor(coreIdentity = core),
            core, matrix, generation)

    @Test fun distinctIdentityFieldsAndOptionalFactorAbsenceDoNotRequireConsoleTrust() {
        val context = succeeds { bind() }
        assertEquals(Fixtures.core(), context.coreIdentity)
        assertEquals(matrix(), context.matrixIdentity)
        // Local identity values contain no factor claim; authentication/current membership is an adapter gate.
        assertTrue(context.accepts(Fixtures.core(), 1))
    }

    @Test fun sameSubjectFromDifferentIssuerOrOrganisationCannotShareContext() {
        val context = succeeds { bind() }
        assertFalse(context.accepts(Fixtures.core(issuer = "https://other.test/realms/atelier"), 1))
        assertFalse(context.accepts(Fixtures.core(organisationId = Fixtures.otherOrganisation), 1))
        assertFalse(context.accepts(Fixtures.core(), 2))
        refuses { bind(core = Fixtures.core(organisationId = Fixtures.otherOrganisation)) }
        refuses { bind(core = Fixtures.core(issuer = "https://other.test/realms/atelier")) }
        refuses { bind(generation = 0) }
    }

    @Test fun matrixMappingRequiresExactOriginalSubjectServerAndHomeserver() {
        for (identity in listOf(matrix(user = "@member-10:atelier.test"), matrix(user = "@Member-1:atelier.test"),
            matrix(user = "@member-1:other.test"), matrix(device = ""), matrix(homeserver = "https://other.test"))) {
            refuses { bind(matrix = identity) }
        }
    }

    @Test fun unsupportedSubjectsAreNotLowercasedEscapedOrRepaired() {
        for (subject in listOf("Member-1", "member:1", "member%31", "f:remote", "", "member name", "équipe")) {
            refuses(DomainError.UNSUPPORTED_SUBJECT) {
                bind(core = Fixtures.core(subject = subject), matrix = matrix(user = "@$subject:atelier.test"))
            }
        }
    }

    @Test fun canonicalLowercaseUUIDSubjectIsSupportedWithoutModification() {
        val subject = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        val context = succeeds { bind(core = Fixtures.core(subject = subject), matrix = matrix(user = "@$subject:atelier.test")) }
        assertEquals(subject, context.coreIdentity.subject)
    }

    @Test fun validatedDescriptorCannotTransferToAnotherCoreSubject() {
        val discovery = succeeds { Fixtures.validatedDiscovery() }
        val descriptor = succeeds { Fixtures.validatedDescriptor() }
        refuses(DomainError.IDENTITY_MISMATCH) {
            AccountContext.bind(discovery, descriptor, Fixtures.core(subject = "member-2"),
                matrix(user = "@member-2:atelier.test"), 1)
        }
    }

    @Test fun signedOutGenerationCannotReviveFromLateIdentityCallback() {
        val session = SessionContext()
        val context = succeeds { bind(generation = session.generation) }
        succeeds { session.activate(context) }
        assertEquals(context, session.account)
        session.signOut()
        assertNull(session.account)
        assertTrue(session.generation > context.generation)
        refuses(DomainError.STALE_GENERATION) { session.activate(context) }
    }
}

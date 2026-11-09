package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

class ChannelIdentityTests {
    private fun reference(id: String = Fixtures.channel, organisation: String = Fixtures.organisation) =
        ChannelReference(organisation, id, ChannelKind.TEXT, ChannelRoomState.READY)

    @Test fun aliasUsesCanonicalUUIDAndPermanentServerRatherThanNetworkHost() {
        val descriptor = succeeds { Fixtures.validatedDescriptor() }
        assertEquals("#kodera-ch-22222222-2222-4222-8222-222222222222:atelier.test",
            succeeds { ChannelIdentity.alias(reference(), descriptor) })
    }

    @Test fun uuidShapeIsExactWithoutInventedVersionRestrictions() {
        val descriptor = succeeds { Fixtures.validatedDescriptor() }
        succeeds { ChannelIdentity.alias(reference(id = "aaaaaaaa-bbbb-0ccc-0ddd-eeeeeeeeeeee"), descriptor) }
        for (id in listOf("bad", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", Fixtures.channel + "extra",
            " " + Fixtures.channel, "22222222222242228222222222222222")) {
            refuses(DomainError.INVALID_CHANNEL) { ChannelIdentity.alias(reference(id = id), descriptor) }
        }
    }

    @Test fun crossOrganisationAndSimilarAliasesCannotSubstitute() {
        val descriptor = succeeds { Fixtures.validatedDescriptor() }
        refuses { ChannelIdentity.alias(reference(organisation = Fixtures.otherOrganisation), descriptor) }
        val expected = succeeds { ChannelIdentity.alias(reference(), descriptor) }
        assertTrue(succeeds { ChannelIdentity.matchesResolvedAlias(expected, reference(), descriptor) })
        for (value in listOf("atelier", "$expected.evil", expected.replace("atelier.test", "matrix.test"),
            "prefix$expected", expected.uppercase())) {
            assertFalse(succeeds { ChannelIdentity.matchesResolvedAlias(value, reference(), descriptor) })
        }
        // Exact alias is identity only; current Matrix membership remains a real-service gate.
    }
}

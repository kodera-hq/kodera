package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MatrixInvitationTests {
    @Test
    fun roomAliasInvitationsBuildAndRoundTripMatrixUriAndMatrixToLinks() {
        val primary = MatrixServerName.parse("community.kodera.io")
        val partner = MatrixServerName.parse("agent.gouv.tchap.gouv.fr:8448")
        val alias = MatrixRoomAlias.parse("#partner-onboarding:community.kodera.io")
        val invite = UniversalMatrixInvitation.forRoomAlias(alias, via = listOf(primary, partner, primary))

        assertEquals(listOf(primary, partner), invite.viaServers)
        assertEquals("#partner-onboarding:community.kodera.io", invite.canonicalIdentifier)
        assertEquals("#partner-onboarding:community.kodera.io", invite.displayAlias)
        assertFalse(invite.isSuggestedAlias)
        assertEquals(
            "matrix:r/partner-onboarding:community.kodera.io?action=join&via=community.kodera.io&via=agent.gouv.tchap.gouv.fr%3A8448",
            invite.matrixUriString,
        )
        assertEquals(
            "https://matrix.to/#/%23partner-onboarding%3Acommunity.kodera.io?via=community.kodera.io&via=agent.gouv.tchap.gouv.fr%3A8448",
            invite.matrixToUrlString,
        )

        assertEquals(invite, UniversalMatrixInvitation.parse(invite.matrixUriString))
        assertEquals(invite, UniversalMatrixInvitation.parse(invite.matrixToUrlString))
    }

    @Test
    fun roomIdentifierWithoutCanonicalAliasComputesSuggestedAliasAndRoundTrips() {
        val server = MatrixServerName.parse("community.kodera.io")
        val roomId = MatrixRoomId.parse("!opaqueRoom_42:community.kodera.io")
        val invite = UniversalMatrixInvitation.forRoom(
            roomId = roomId,
            canonicalAlias = null,
            channelSlug = "Show and Tell",
            serverName = server,
        )

        assertTrue(invite.isSuggestedAlias)
        assertEquals("#show-and-tell:community.kodera.io", invite.displayAlias)
        assertEquals("!opaqueRoom_42:community.kodera.io", invite.canonicalIdentifier)
        assertEquals(
            "matrix:roomid/opaqueRoom_42:community.kodera.io?action=join&via=community.kodera.io",
            invite.matrixUriString,
        )

        val parsed = UniversalMatrixInvitation.parse(invite.matrixUriString)
        assertEquals("!opaqueRoom_42:community.kodera.io", parsed.canonicalIdentifier)
        assertEquals(listOf(server), parsed.viaServers)
    }

    @Test
    fun directUserMatrixIdBuildsChatUriAndRefusesViaOrInjectionPayloads() {
        val user = MatrixUserId.parse("@alice.martin:element.io")
        val invite = UniversalMatrixInvitation.forDirectUser(user)

        assertEquals("@alice.martin:element.io", invite.canonicalIdentifier)
        assertEquals("matrix:u/alice.martin:element.io?action=chat", invite.matrixUriString)
        assertEquals("https://matrix.to/#/%40alice.martin%3Aelement.io", invite.matrixToUrlString)
        assertEquals(invite, UniversalMatrixInvitation.parse(invite.matrixUriString))
        assertEquals(invite, UniversalMatrixInvitation.parse(invite.matrixToUrlString))
        assertEquals(invite, UniversalMatrixInvitation.parse("@alice.martin:element.io"))
    }

    @Test
    fun malformedHostsPortsPercentEscapesAndInjectionInputsRefuseDeterministically() {
        val refused = listOf(
            "" to MatrixInvitationError.EMPTY_INPUT,
            "plain-room" to MatrixInvitationError.MISSING_SIGIL,
            "@missing-domain" to MatrixInvitationError.INVALID_DOMAIN,
            "mailto:alice@kodera.io" to MatrixInvitationError.UNSUPPORTED_SCHEME,
            "@user:localhost" to MatrixInvitationError.INVALID_DOMAIN,
            "@user:127.0.0.1" to MatrixInvitationError.INVALID_DOMAIN,
            "@user:kodera.io:08448" to MatrixInvitationError.INVALID_PORT,
            "@user:kodera.io:70000" to MatrixInvitationError.INVALID_PORT,
            "#bad/slash:kodera.io" to MatrixInvitationError.INVALID_LOCALPART,
            "#bad?query:kodera.io" to MatrixInvitationError.INVALID_LOCALPART,
            "matrix://community.kodera.io/r/dev:community.kodera.io" to MatrixInvitationError.AUTHORITY_NOT_ALLOWED,
            "http://matrix.to/#/%23dev%3Akodera.io" to MatrixInvitationError.UNSUPPORTED_SCHEME,
            "https://evil.example/#/%23dev%3Akodera.io" to MatrixInvitationError.UNSUPPORTED_HOST,
            "matrix:r/dev:kodera.io?action=evil" to MatrixInvitationError.UNSUPPORTED_ACTION,
            "matrix:u/alice:kodera.io?action=chat&via=kodera.io" to MatrixInvitationError.INVALID_VIA_SERVER,
            "matrix:r/dev%00injected:kodera.io?action=join" to MatrixInvitationError.INVALID_CHARACTER,
            "matrix:r/dev%0d%0ainjected:kodera.io?action=join" to MatrixInvitationError.INVALID_CHARACTER,
            "@alice:kodera.io\n@bob:kodera.io" to MatrixInvitationError.INVALID_CHARACTER,
        )

        for ((sample, expectedError) in refused) {
            try {
                UniversalMatrixInvitation.parse(sample)
                fail("Expected refusal for: $sample")
            } catch (failure: MatrixInvitationFailure) {
                assertEquals(sample, expectedError, failure.reason)
            }
        }
    }
}

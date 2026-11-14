package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommunityStructureTests {
    @Test
    fun canonicalThreeCategoriesAudienceAndPartnerBadgesMatchBlueprint() {
        val categories = CommunityWorkspaceBlueprint.categories
        assertEquals(3, categories.size)
        assertEquals("community", CommunityWorkspaceBlueprint.CANONICAL_SLUG)
        assertEquals("community.kodera.io", CommunityWorkspaceBlueprint.CANONICAL_DOMAIN)

        val community = categories[0]
        assertEquals(CommunityCategoryId.COMMUNITY, community.categoryId)
        assertEquals("Community", community.name)
        assertEquals(CommunityAudience.PUBLIC_OPEN, community.audience)
        assertFalse(community.showsFederatedPartnerBadge)
        assertTrue(community.partnerBadges.isEmpty())
        assertEquals(7, community.channels.size)
        assertTrue(community.channels.all { !it.isPrivateByDefault })
        assertTrue(community.channels.single { it.id == "office-hours" }.isVoice)

        val core = categories[1]
        assertEquals(CommunityCategoryId.CORE_KODERA, core.categoryId)
        assertEquals("Core Kodera", core.name)
        assertEquals(CommunityAudience.CORE_TEAM, core.audience)
        assertFalse(core.showsFederatedPartnerBadge)
        assertTrue(core.keepsInternalRoomsPrivate)
        assertEquals(listOf("dev", "strategy", "ops-oncall"), core.channels.map { it.id })
        assertTrue(core.channels.all { it.visibility == CommunityChannelVisibility.PRIVATE_INTERNAL && it.isPrivateByDefault })

        val partners = categories[2]
        assertEquals(CommunityCategoryId.DESIGN_PARTNERS, partners.categoryId)
        assertEquals("Design Partners", partners.name)
        assertEquals(CommunityAudience.FEDERATED_PARTNERS, partners.audience)
        assertTrue(partners.showsFederatedPartnerBadge)
        assertEquals(
            listOf(
                FederatedMatrixPartnerClient.ELEMENT,
                FederatedMatrixPartnerClient.TCHAP,
                FederatedMatrixPartnerClient.CINNY,
            ),
            partners.partnerBadges,
        )
        assertEquals(listOf("partner-onboarding", "partner-feedback"), partners.channels.map { it.id })
        assertTrue(partners.channels.all { it.isFederatedPartnerRoom && it.isPrivateByDefault })
    }

    @Test
    fun categoryAndChannelMatchingNormalizesCaseSpacesAndUnderscores() {
        assertEquals(
            CommunityCategoryId.CORE_KODERA,
            CommunityWorkspaceBlueprint.matchCategory(name = "  Core_Kodera  ")?.categoryId,
        )
        assertEquals(
            CommunityCategoryId.DESIGN_PARTNERS,
            CommunityWorkspaceBlueprint.matchCategory(name = "Custom Label", templateKey = "design_partners")?.categoryId,
        )
        assertNotNull(CommunityWorkspaceBlueprint.matchChannel("Developers Community"))
        assertNull(CommunityWorkspaceBlueprint.matchCategory(name = "unknown-category"))
        assertNull(CommunityWorkspaceBlueprint.matchChannel("nonexistent-room"))
    }
}

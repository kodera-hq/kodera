package io.kodera.android.domain

/** Target audience for canonical `community.kodera.io` workspace categories. */
enum class CommunityAudience(val key: String) {
    PUBLIC_OPEN("audiencePublic"),
    CORE_TEAM("audienceCore"),
    FEDERATED_PARTNERS("audiencePartners"),
}

/** Canonical 3-category layout shared across Web, iOS, and Android. */
enum class CommunityCategoryId(val slug: String) {
    COMMUNITY("community"),
    CORE_KODERA("core-kodera"),
    DESIGN_PARTNERS("design-partners"),
}

enum class CommunityChannelKind {
    TEXT,
    AUDIO,
}

/**
 * Default room access posture. Internal core rooms remain private by default;
 * federated partner rooms require explicit invitation across Matrix homeservers.
 */
enum class CommunityChannelVisibility(val isPrivateByDefault: Boolean) {
    PUBLIC_COMMUNITY(isPrivateByDefault = false),
    PRIVATE_INTERNAL(isPrivateByDefault = true),
    FEDERATED_PARTNER_INVITE(isPrivateByDefault = true),
}

/** Interoperable federated Matrix clients highlighted on partner-facing rooms. */
enum class FederatedMatrixPartnerClient(val id: String, val displayName: String) {
    ELEMENT("element", "Element"),
    TCHAP("tchap", "Tchap"),
    CINNY("cinny", "Cinny"),
}

enum class CommunityChannelTopic {
    RELEASES,
    DEVELOPERS,
    SUPPORT,
    EXTENSIONS,
    SELF_HOST,
    SHOW_TELL,
    OFFICE,
    ENGINEERING,
    STRATEGY,
    OPERATIONS,
    PARTNER_ONBOARDING,
    PARTNER_FEEDBACK,
}

/**
 * Canonical channel blueprint aligned with `community.kodera.io`.
 * Blueprint metadata describes room structure only and never grants live room membership.
 */
data class CommunityChannelBlueprint(
    val id: String,
    val name: String,
    val kind: CommunityChannelKind,
    val topic: CommunityChannelTopic,
    val categoryId: CommunityCategoryId,
    val visibility: CommunityChannelVisibility,
    val partnerBadges: List<FederatedMatrixPartnerClient> = emptyList(),
) {
    val isVoice: Boolean get() = kind == CommunityChannelKind.AUDIO
    val isPrivateByDefault: Boolean get() = visibility.isPrivateByDefault
    val isFederatedPartnerRoom: Boolean get() = categoryId == CommunityCategoryId.DESIGN_PARTNERS
}

/** Canonical category definition for the 3-category `community.kodera.io` workspace structure. */
data class CommunityCategoryBlueprint(
    val categoryId: CommunityCategoryId,
    val name: String,
    val audience: CommunityAudience,
    val defaultVisibility: CommunityChannelVisibility,
    val showsFederatedPartnerBadge: Boolean,
    val partnerBadges: List<FederatedMatrixPartnerClient>,
    val channels: List<CommunityChannelBlueprint>,
) {
    val id: String get() = categoryId.slug
    val keepsInternalRoomsPrivate: Boolean
        get() = defaultVisibility.isPrivateByDefault && channels.all { it.isPrivateByDefault }
}

object CommunityWorkspaceBlueprint {
    const val CANONICAL_SLUG: String = "community"
    const val CANONICAL_DOMAIN: String = "community.kodera.io"

    val federatedPartnerClients: List<FederatedMatrixPartnerClient> = listOf(
        FederatedMatrixPartnerClient.ELEMENT,
        FederatedMatrixPartnerClient.TCHAP,
        FederatedMatrixPartnerClient.CINNY,
    )

    val categories: List<CommunityCategoryBlueprint> = listOf(
        CommunityCategoryBlueprint(
            categoryId = CommunityCategoryId.COMMUNITY,
            name = "Community",
            audience = CommunityAudience.PUBLIC_OPEN,
            defaultVisibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
            showsFederatedPartnerBadge = false,
            partnerBadges = emptyList(),
            channels = listOf(
                CommunityChannelBlueprint(
                    id = "announcements",
                    name = "announcements",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.RELEASES,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "developers-community",
                    name = "developers-community",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.DEVELOPERS,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "support",
                    name = "support",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.SUPPORT,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "extensions",
                    name = "extensions",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.EXTENSIONS,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "self-hosting",
                    name = "self-hosting",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.SELF_HOST,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "show-and-tell",
                    name = "show-and-tell",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.SHOW_TELL,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
                CommunityChannelBlueprint(
                    id = "office-hours",
                    name = "office-hours",
                    kind = CommunityChannelKind.AUDIO,
                    topic = CommunityChannelTopic.OFFICE,
                    categoryId = CommunityCategoryId.COMMUNITY,
                    visibility = CommunityChannelVisibility.PUBLIC_COMMUNITY,
                ),
            ),
        ),
        CommunityCategoryBlueprint(
            categoryId = CommunityCategoryId.CORE_KODERA,
            name = "Core Kodera",
            audience = CommunityAudience.CORE_TEAM,
            defaultVisibility = CommunityChannelVisibility.PRIVATE_INTERNAL,
            showsFederatedPartnerBadge = false,
            partnerBadges = emptyList(),
            channels = listOf(
                CommunityChannelBlueprint(
                    id = "dev",
                    name = "dev",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.ENGINEERING,
                    categoryId = CommunityCategoryId.CORE_KODERA,
                    visibility = CommunityChannelVisibility.PRIVATE_INTERNAL,
                ),
                CommunityChannelBlueprint(
                    id = "strategy",
                    name = "strategy",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.STRATEGY,
                    categoryId = CommunityCategoryId.CORE_KODERA,
                    visibility = CommunityChannelVisibility.PRIVATE_INTERNAL,
                ),
                CommunityChannelBlueprint(
                    id = "ops-oncall",
                    name = "ops-oncall",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.OPERATIONS,
                    categoryId = CommunityCategoryId.CORE_KODERA,
                    visibility = CommunityChannelVisibility.PRIVATE_INTERNAL,
                ),
            ),
        ),
        CommunityCategoryBlueprint(
            categoryId = CommunityCategoryId.DESIGN_PARTNERS,
            name = "Design Partners",
            audience = CommunityAudience.FEDERATED_PARTNERS,
            defaultVisibility = CommunityChannelVisibility.FEDERATED_PARTNER_INVITE,
            showsFederatedPartnerBadge = true,
            partnerBadges = federatedPartnerClients,
            channels = listOf(
                CommunityChannelBlueprint(
                    id = "partner-onboarding",
                    name = "partner-onboarding",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.PARTNER_ONBOARDING,
                    categoryId = CommunityCategoryId.DESIGN_PARTNERS,
                    visibility = CommunityChannelVisibility.FEDERATED_PARTNER_INVITE,
                    partnerBadges = federatedPartnerClients,
                ),
                CommunityChannelBlueprint(
                    id = "partner-feedback",
                    name = "partner-feedback",
                    kind = CommunityChannelKind.TEXT,
                    topic = CommunityChannelTopic.PARTNER_FEEDBACK,
                    categoryId = CommunityCategoryId.DESIGN_PARTNERS,
                    visibility = CommunityChannelVisibility.FEDERATED_PARTNER_INVITE,
                    partnerBadges = federatedPartnerClients,
                ),
            ),
        ),
    )

    val channels: List<CommunityChannelBlueprint> = categories.flatMap { it.channels }

    fun matchCategory(
        id: String? = null,
        name: String,
        templateKey: String? = null,
    ): CommunityCategoryBlueprint? {
        if (id != null) {
            categories.firstOrNull { it.id == normalizeIdentifier(id) }?.let { return it }
        }
        if (templateKey != null) {
            categories.firstOrNull { it.id == normalizeIdentifier(templateKey) }?.let { return it }
        }
        val normalizedName = normalizeIdentifier(name)
        return categories.firstOrNull {
            it.id == normalizedName || normalizeIdentifier(it.name) == normalizedName
        }
    }

    fun matchChannel(name: String): CommunityChannelBlueprint? {
        val normalized = normalizeIdentifier(name)
        return channels.firstOrNull { it.id == normalized }
    }

    private fun normalizeIdentifier(raw: String): String =
        raw.trim()
            .lowercase()
            .replace('_', '-')
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }
            .joinToString("-")
}

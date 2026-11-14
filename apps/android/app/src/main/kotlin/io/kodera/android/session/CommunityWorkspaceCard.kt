package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.domain.CommunityAudience
import io.kodera.android.domain.CommunityCategoryBlueprint
import io.kodera.android.domain.CommunityChannelBlueprint
import io.kodera.android.domain.CommunityChannelTopic
import io.kodera.android.domain.CommunityChannelVisibility
import io.kodera.android.domain.CommunityWorkspaceBlueprint
import io.kodera.android.domain.MatrixInvitationFailure
import io.kodera.android.domain.MatrixServerName
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

internal object CommunityCategoryPresentation {
    fun audienceLabelRes(audience: CommunityAudience): Int = when (audience) {
        CommunityAudience.PUBLIC_OPEN -> R.string.community_audience_public
        CommunityAudience.CORE_TEAM -> R.string.community_audience_core
        CommunityAudience.FEDERATED_PARTNERS -> R.string.community_audience_partners
    }

    fun topicLabelRes(topic: CommunityChannelTopic): Int = when (topic) {
        CommunityChannelTopic.RELEASES -> R.string.community_topic_releases
        CommunityChannelTopic.DEVELOPERS -> R.string.community_topic_developers
        CommunityChannelTopic.SUPPORT -> R.string.community_topic_support
        CommunityChannelTopic.EXTENSIONS -> R.string.community_topic_extensions
        CommunityChannelTopic.SELF_HOST -> R.string.community_topic_self_host
        CommunityChannelTopic.SHOW_TELL -> R.string.community_topic_show_tell
        CommunityChannelTopic.OFFICE -> R.string.community_topic_office
        CommunityChannelTopic.ENGINEERING -> R.string.community_topic_engineering
        CommunityChannelTopic.STRATEGY -> R.string.community_topic_strategy
        CommunityChannelTopic.OPERATIONS -> R.string.community_topic_operations
        CommunityChannelTopic.PARTNER_ONBOARDING -> R.string.community_topic_partner_onboarding
        CommunityChannelTopic.PARTNER_FEEDBACK -> R.string.community_topic_partner_feedback
    }

    fun makeInviteScope(
        organisationId: String?,
        channelId: String,
        channelName: String,
        serverHost: String = CommunityWorkspaceBlueprint.CANONICAL_DOMAIN,
    ): ChannelInviteScope? {
        if (organisationId == null) return null
        val server = try {
            MatrixServerName.parse(serverHost)
        } catch (_: MatrixInvitationFailure) {
            return null
        }
        return try {
            ChannelInviteScope.create(
                organisationId = organisationId,
                channelId = channelId,
                channelName = channelName,
                serverName = server,
            )
        } catch (_: ChannelInviteFailure) {
            null
        }
    }
}

/**
 * Renders the canonical 3-category `community.kodera.io` workspace structure
 * (`Community`, `Core Kodera`, `Design Partners`) with audience subtitles, private internal
 * room indicators, federated Matrix partner badges (`Element`, `Tchap`, `Cinny`), and
 * universal in-app Matrix invitation sheets.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CommunityWorkspaceCard(
    organisationId: String?,
    inviteCoordinator: ChannelInviteCoordinator? = null,
    onCopyText: ((String) -> Unit)? = null,
) {
    val palette = LocalKoderaPalette.current
    val coordinator = remember(inviteCoordinator) { inviteCoordinator ?: ChannelInviteCoordinator() }
    var sheetContext by remember(organisationId) { mutableStateOf<ChannelInviteContext?>(null) }
    val currentSheetContext by rememberUpdatedState(sheetContext)

    DisposableEffect(organisationId, coordinator) {
        onDispose {
            currentSheetContext?.let { coordinator.dismissSheet(it) }
        }
    }

    CielGlassCard {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s5),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                Text(
                    stringResource(R.string.community_title),
                    style = NativeTypography.heading,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    CommunityWorkspaceBlueprint.CANONICAL_DOMAIN,
                    style = NativeTypography.monoCaption,
                    color = palette.accentInk,
                )
                Text(
                    stringResource(R.string.community_subtitle),
                    style = NativeTypography.caption,
                    color = palette.ink2,
                )
            }

            CommunityWorkspaceBlueprint.categories.forEachIndexed { index, category ->
                if (index > 0) {
                    HorizontalDivider(color = palette.borderSoft)
                }
                CommunityCategoryBlock(
                    category = category,
                    organisationId = organisationId,
                    onOpenInvite = { scope ->
                        sheetContext = try {
                            coordinator.openSheet(scope)
                        } catch (_: ChannelInviteFailure) {
                            null
                        }
                    },
                )
            }
        }
    }

    val activeContext = sheetContext
    val activeScope = coordinator.activeScope
    if (activeContext != null && activeScope != null && coordinator.isCurrentContext(activeContext)) {
        ChannelInviteSheet(
            scope = activeScope,
            coordinator = coordinator,
            context = activeContext,
            onDismiss = {
                coordinator.dismissSheet(activeContext)
                sheetContext = null
            },
            onCopyText = onCopyText,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CommunityCategoryBlock(
    category: CommunityCategoryBlueprint,
    organisationId: String?,
    onOpenInvite: (ChannelInviteScope) -> Unit,
) {
    val palette = LocalKoderaPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3)) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
        ) {
            Text(
                category.name,
                style = NativeTypography.emphasis,
                modifier = Modifier.semantics { heading() },
            )
            if (category.defaultVisibility == CommunityChannelVisibility.PRIVATE_INTERNAL) {
                CielBadgePill(
                    label = stringResource(R.string.community_private_internal_badge),
                    containerColor = palette.t5Bg,
                    contentColor = palette.t5Fg,
                )
            }
            if (category.showsFederatedPartnerBadge) {
                CielBadgePill(
                    label = stringResource(R.string.community_federated_badge),
                    containerColor = palette.tag1Bg,
                    contentColor = palette.tag1Fg,
                )
                for (partner in category.partnerBadges) {
                    CielBadgePill(
                        label = partner.displayName,
                        containerColor = palette.t2Bg,
                        contentColor = palette.t2Fg,
                    )
                }
            }
        }
        Text(
            stringResource(CommunityCategoryPresentation.audienceLabelRes(category.audience)),
            style = NativeTypography.caption,
            color = palette.ink3,
        )

        for (channel in category.channels) {
            CommunityChannelRow(
                channel = channel,
                organisationId = organisationId,
                onOpenInvite = onOpenInvite,
            )
        }
    }
}

@Composable
private fun CommunityChannelRow(
    channel: CommunityChannelBlueprint,
    organisationId: String?,
    onOpenInvite: (ChannelInviteScope) -> Unit,
) {
    val palette = LocalKoderaPalette.current
    val inviteScope = remember(organisationId, channel.id, channel.name) {
        CommunityCategoryPresentation.makeInviteScope(
            organisationId = organisationId,
            channelId = channel.id,
            channelName = channel.name,
        )
    }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                if (channel.isVoice) channel.name else "#${channel.name}",
                style = NativeTypography.monoBody,
                color = palette.ink,
            )
            if (inviteScope != null && channel.visibility != CommunityChannelVisibility.PRIVATE_INTERNAL) {
                OutlinedButton(
                    onClick = { onOpenInvite(inviteScope) },
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s10),
                ) {
                    Text(
                        stringResource(R.string.invite_open_button),
                        style = NativeTypography.caption,
                        color = palette.accentInk,
                    )
                }
            }
        }
        Text(
            stringResource(CommunityCategoryPresentation.topicLabelRes(channel.topic)),
            style = NativeTypography.caption,
            color = palette.ink2,
        )
    }
}

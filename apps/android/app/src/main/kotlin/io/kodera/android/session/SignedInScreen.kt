package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.client.ChannelPollSession
import io.kodera.android.client.DocsWorkspaceSession
import io.kodera.android.client.ProximityCheckInSession
import io.kodera.android.client.SoundPreferencesSession
import io.kodera.android.client.VoiceCallDockSession
import io.kodera.android.client.WorkspaceChannel
import io.kodera.android.client.WorkspaceChannelLifecycle
import io.kodera.android.client.WorkspacePreferencesScope
import io.kodera.android.client.WorkspacePreferencesSession
import io.kodera.android.client.WorkspaceSetupState
import io.kodera.android.client.WorkspaceState
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.CommunityChannelVisibility
import io.kodera.android.domain.CommunityWorkspaceBlueprint
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Current member and read-only organisation channels, with sign-out before potentially long metadata. */
@Composable
fun SignedInScreen(
    member: MemberState,
    workspace: WorkspaceViewState,
    onRetry: () -> Unit,
    onCheckAgain: () -> Unit,
    onWorkspaceRetry: () -> Unit,
    onSignOut: () -> Unit,
    proximitySession: ProximityCheckInSession? = null,
    voiceCallSession: VoiceCallDockSession? = null,
    docsSession: DocsWorkspaceSession? = null,
    soundPreferencesSession: SoundPreferencesSession? = null,
    pollSession: ChannelPollSession? = null,
    workspacePreferencesSession: WorkspacePreferencesSession? = null,
    telecomCoordinator: TelecomPushCoordinator? = null,
    proximityV2Controller: ProximityV2CheckInController? = null,
    inviteCoordinator: ChannelInviteCoordinator? = null,
    passkeyCoordinator: PasskeySessionCoordinator? = null,
    onCopyInviteText: ((String) -> Unit)? = null,
) {
    val palette = LocalKoderaPalette.current
    val loadedOrganisationId = (workspace as? WorkspaceViewState.Loaded)?.snapshot?.organisationId
    Surface(modifier = Modifier.fillMaxSize(), color = palette.page, contentColor = palette.ink) {
        Box(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = KoderaTokens.Space.shellDocumentMinWidth).fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = KoderaTokens.Space.s6, vertical = KoderaTokens.Space.s8),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s8),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
                    Text(stringResource(R.string.brand_name), style = NativeTypography.wordmark, color = palette.action,
                        modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.session_title), style = NativeTypography.title, modifier = Modifier.semantics { heading() })
                }
                CielGlassCard {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
                    ) { MemberCard(member, onRetry, onCheckAgain) }
                }
                Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                        // Ink, not the danger role: bad on page is under 4.5:1 in the dark palettes.
                        Text(stringResource(R.string.session_sign_out), style = NativeTypography.emphasis, color = palette.ink)
                    }
                    Text(stringResource(R.string.session_sign_out_hint), style = NativeTypography.caption, color = palette.ink3)
                }
                if (member is MemberState.Loaded && workspace != WorkspaceViewState.Hidden) {
                    PasskeyDeviceBindingCard(coordinator = passkeyCoordinator)
                    ProximityCheckInCard(
                        session = proximitySession?.takeIf {
                            workspace is WorkspaceViewState.Loaded && it.organisationId == workspace.snapshot.organisationId
                        },
                        organisationId = loadedOrganisationId,
                        v2Controller = proximityV2Controller,
                    )
                    WorkspaceSection(
                        state = workspace,
                        onRetry = onWorkspaceRetry,
                        inviteCoordinator = inviteCoordinator,
                        onCopyInviteText = onCopyInviteText,
                    )
                    CommunityWorkspaceCard(
                        organisationId = loadedOrganisationId,
                        inviteCoordinator = inviteCoordinator,
                        onCopyText = onCopyInviteText,
                    )
                    VoiceCallDockCard(
                        session = voiceCallSession?.takeIf { session ->
                            workspace is WorkspaceViewState.Loaded && session.scope.organisationId == workspace.snapshot.organisationId &&
                                (workspace.snapshot.categories.flatMap { it.channels } + workspace.snapshot.uncategorisedChannels).any {
                                    it.id == session.scope.channelId && it.kind == ChannelKind.AUDIO &&
                                        it.lifecycle == WorkspaceChannelLifecycle.ACTIVE
                                }
                        },
                        telecomCoordinator = telecomCoordinator,
                    )
                    DocsWorkspaceCard(docsSession?.takeIf { session ->
                        workspace is WorkspaceViewState.Loaded && session.scope.organisationId == workspace.snapshot.organisationId &&
                            (workspace.snapshot.categories.flatMap { it.channels } + workspace.snapshot.uncategorisedChannels).any {
                                it.id == session.scope.channelId && it.kind == ChannelKind.TEXT &&
                                    it.lifecycle == WorkspaceChannelLifecycle.ACTIVE
                            }
                    })
                    SoundPreferencesCard(soundPreferencesSession?.takeIf {
                        workspace is WorkspaceViewState.Loaded && it.scope.organisationId == workspace.snapshot.organisationId
                    })
                    ChannelPollCard(pollSession?.takeIf { session ->
                        workspace is WorkspaceViewState.Loaded && session.scope.organisationId == workspace.snapshot.organisationId &&
                            (workspace.snapshot.categories.flatMap { it.channels } + workspace.snapshot.uncategorisedChannels).any {
                                it.id == session.scope.channelId && it.kind == ChannelKind.TEXT &&
                                    it.lifecycle == WorkspaceChannelLifecycle.ACTIVE
                            }
                    })
                    WorkspacePreferencesCard(workspacePreferencesSession?.takeIf { session ->
                        workspace is WorkspaceViewState.Loaded && session.scope.organisationId == workspace.snapshot.organisationId &&
                            (workspace.snapshot.categories.flatMap { it.channels } + workspace.snapshot.uncategorisedChannels).any {
                                it.id == session.scope.channelId && it.kind == ChannelKind.TEXT &&
                                    it.lifecycle == WorkspaceChannelLifecycle.ACTIVE
                            }
                    }, previewScope = (workspace as? WorkspaceViewState.Loaded)?.snapshot?.let { snapshot ->
                        (snapshot.categories.flatMap { it.channels } + snapshot.uncategorisedChannels).firstOrNull {
                            it.kind == ChannelKind.TEXT && it.lifecycle == WorkspaceChannelLifecycle.ACTIVE
                        }?.let { channel -> runCatching { WorkspacePreferencesScope(snapshot.organisationId, channel.id) }.getOrNull() }
                    })
                }
            }
        }
    }
}

/** Launch, while the sealed session is read back: progress, never a blank screen. */
@Composable
fun RestoringScreen() {
    val palette = LocalKoderaPalette.current
    Surface(modifier = Modifier.fillMaxSize(), color = palette.page, contentColor = palette.ink) {
        Box(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.Center) {
            Column(
                modifier = Modifier.padding(KoderaTokens.Space.s6).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(KoderaTokens.Space.s6).clearAndSetSemantics {},
                    color = palette.accentInk)
                Text(stringResource(R.string.session_restoring), style = NativeTypography.body, color = palette.ink2)
            }
        }
    }
}

@Composable
private fun MemberCard(member: MemberState, onRetry: () -> Unit, onCheckAgain: () -> Unit) {
    val palette = LocalKoderaPalette.current
    when (member) {
        MemberState.Loading -> {
            // The text says it once; the spinner itself is silent to TalkBack. accentInk, not action:
            // action on the dark surface is under 3:1.
            CircularProgressIndicator(modifier = Modifier.size(KoderaTokens.Space.s6).clearAndSetSemantics {},
                color = palette.accentInk)
            Text(stringResource(R.string.session_loading), style = NativeTypography.body, color = palette.ink2)
        }
        is MemberState.Loaded -> {
            Column(modifier = Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                Text(stringResource(R.string.session_member), style = NativeTypography.caption, color = palette.ink3)
                Text(member.name, style = NativeTypography.heading)
            }
            member.organisation?.let { organisation ->
                Column(modifier = Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    Text(stringResource(R.string.session_organisation), style = NativeTypography.caption, color = palette.ink3)
                    Text(organisation, style = NativeTypography.emphasis)
                }
            }
        }
        MemberState.CoreUnavailable -> {
            Text(stringResource(R.string.session_core_unavailable), style = NativeTypography.body, color = palette.ink2)
            OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                // accentInk, not action: action on surface is under 4.5:1 in the dark palettes.
                Text(stringResource(R.string.session_retry), style = NativeTypography.emphasis, color = palette.accentInk)
            }
        }
        // A 403 is an answer, not an outage, and never a dead end: Check again, and sign-out below. An owner's
        // claim is finished on the web, never in the app; that changes Core's answer, so coming back to the app
        // checks again too (the Activity's resume). The app is a companion: it opens no page outside sign-in, so
        // it offers no link to the Console, where the organisation's commercial pages live.
        MemberState.NoOrganisationYet -> {
            Text(stringResource(R.string.session_no_organisation), style = NativeTypography.body, color = palette.ink2)
            OutlinedButton(onClick = onCheckAgain, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                // accentInk, not action: action on surface is under 4.5:1 in the dark palettes.
                Text(stringResource(R.string.session_check_again), style = NativeTypography.emphasis, color = palette.accentInk)
            }
            Text(stringResource(R.string.session_check_again_hint), style = NativeTypography.caption, color = palette.ink3)
        }
    }
}

/** One status-only live region, never the channel list or its surrounding controls. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkspaceSection(
    state: WorkspaceViewState,
    onRetry: () -> Unit,
    inviteCoordinator: ChannelInviteCoordinator? = null,
    onCopyInviteText: ((String) -> Unit)? = null,
) {
    val palette = LocalKoderaPalette.current
    val loadedOrganisationId = (state as? WorkspaceViewState.Loaded)?.snapshot?.organisationId
    var workspaceSheetContext by remember(loadedOrganisationId) { mutableStateOf<ChannelInviteContext?>(null) }
    val currentSheetContext by rememberUpdatedState(workspaceSheetContext)

    DisposableEffect(loadedOrganisationId, inviteCoordinator) {
        onDispose {
            val active = currentSheetContext
            if (active != null && inviteCoordinator != null) {
                inviteCoordinator.dismissSheet(active)
            }
        }
    }

    CielGlassCard {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
        ) {
            Text(stringResource(R.string.workspace_title), style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.workspace_readonly_hint), style = NativeTypography.caption, color = palette.ink2)
            val status = when (state) {
                WorkspaceViewState.Hidden -> null
                WorkspaceViewState.Loading -> R.string.workspace_loading
                is WorkspaceViewState.Unavailable -> state.message
                is WorkspaceViewState.Loaded -> R.string.workspace_updated
            }
            if (state == WorkspaceViewState.Loading) {
                CircularProgressIndicator(modifier = Modifier.size(KoderaTokens.Space.s6).clearAndSetSemantics {},
                    color = palette.accentInk)
            }
            if (status != null) Text(stringResource(status), style = NativeTypography.body, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (state is WorkspaceViewState.Unavailable) {
                OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.session_retry), style = NativeTypography.emphasis, color = palette.accentInk)
                }
                Text(stringResource(R.string.workspace_retry_hint), style = NativeTypography.caption, color = palette.ink3)
            }
            if (state is WorkspaceViewState.Loaded) {
                val snapshot = state.snapshot
                val setupLabel = when (snapshot.setup.state) {
                    WorkspaceSetupState.PENDING -> R.string.workspace_setup_pending
                    WorkspaceSetupState.RUNNING -> R.string.workspace_setup_running
                    WorkspaceSetupState.FAILED -> R.string.workspace_setup_failed
                    WorkspaceSetupState.READY -> null
                }
                if (setupLabel != null) Text(stringResource(setupLabel), style = NativeTypography.body, color = palette.ink2)
                if (snapshot.state == WorkspaceState.NOT_INITIALISED) {
                    Text(stringResource(R.string.workspace_not_initialised), style = NativeTypography.body)
                } else {
                    if (snapshot.categories.all { it.channels.isEmpty() } && snapshot.uncategorisedChannels.isEmpty()) {
                        Text(stringResource(R.string.workspace_empty), style = NativeTypography.body)
                    }
                    for (category in snapshot.categories) {
                        val matchedCategory = CommunityWorkspaceBlueprint.matchCategory(
                            id = category.id,
                            name = category.name,
                            templateKey = category.templateKey,
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                        ) {
                            Text(category.name, style = NativeTypography.emphasis, modifier = Modifier.semantics { heading() })
                            if (matchedCategory != null) {
                                if (matchedCategory.defaultVisibility == CommunityChannelVisibility.PRIVATE_INTERNAL) {
                                    CielBadgePill(
                                        label = stringResource(R.string.community_private_internal_badge),
                                        containerColor = palette.t5Bg,
                                        contentColor = palette.t5Fg,
                                    )
                                }
                                if (matchedCategory.showsFederatedPartnerBadge) {
                                    CielBadgePill(
                                        label = stringResource(R.string.community_federated_badge),
                                        containerColor = palette.tag1Bg,
                                        contentColor = palette.tag1Fg,
                                    )
                                    for (partner in matchedCategory.partnerBadges) {
                                        CielBadgePill(
                                            label = partner.displayName,
                                            containerColor = palette.t2Bg,
                                            contentColor = palette.t2Fg,
                                        )
                                    }
                                }
                            }
                        }
                        if (matchedCategory != null) {
                            Text(
                                stringResource(CommunityCategoryPresentation.audienceLabelRes(matchedCategory.audience)),
                                style = NativeTypography.caption,
                                color = palette.ink3,
                            )
                        }
                        val categoryPrivateInternal = matchedCategory?.defaultVisibility == CommunityChannelVisibility.PRIVATE_INTERNAL
                        for (channel in category.channels) {
                            val isPrivateInternal = categoryPrivateInternal ||
                                CommunityWorkspaceBlueprint.matchChannel(channel.name)?.visibility == CommunityChannelVisibility.PRIVATE_INTERNAL
                            ChannelMetadata(
                                channel = channel,
                                organisationId = snapshot.organisationId,
                                canInvite = inviteCoordinator != null && !isPrivateInternal,
                                onOpenInvite = { scope ->
                                    workspaceSheetContext = inviteCoordinator?.let {
                                        try { it.openSheet(scope) } catch (_: ChannelInviteFailure) { null }
                                    }
                                },
                            )
                        }
                    }
                    if (snapshot.uncategorisedChannels.isNotEmpty()) {
                        Text(stringResource(R.string.workspace_uncategorised), style = NativeTypography.emphasis,
                            modifier = Modifier.semantics { heading() })
                        for (channel in snapshot.uncategorisedChannels) {
                            val isPrivateInternal =
                                CommunityWorkspaceBlueprint.matchChannel(channel.name)?.visibility == CommunityChannelVisibility.PRIVATE_INTERNAL
                            ChannelMetadata(
                                channel = channel,
                                organisationId = snapshot.organisationId,
                                canInvite = inviteCoordinator != null && !isPrivateInternal,
                                onOpenInvite = { scope ->
                                    workspaceSheetContext = inviteCoordinator?.let {
                                        try { it.openSheet(scope) } catch (_: ChannelInviteFailure) { null }
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    val activeContext = workspaceSheetContext
    val activeScope = inviteCoordinator?.activeScope
    if (inviteCoordinator != null && activeContext != null && activeScope != null &&
        inviteCoordinator.isCurrentContext(activeContext)
    ) {
        ChannelInviteSheet(
            scope = activeScope,
            coordinator = inviteCoordinator,
            context = activeContext,
            onDismiss = {
                inviteCoordinator.dismissSheet(activeContext)
                workspaceSheetContext = null
            },
            onCopyText = onCopyInviteText,
        )
    }
}

/** Plain text metadata with optional universal Matrix invitation sheet for active non-internal channels. */
@Composable
private fun ChannelMetadata(
    channel: WorkspaceChannel,
    organisationId: String,
    canInvite: Boolean = false,
    onOpenInvite: ((ChannelInviteScope) -> Unit)? = null,
) {
    val palette = LocalKoderaPalette.current
    val inviteScope = remember(organisationId, channel.id, channel.name, canInvite, channel.lifecycle) {
        if (canInvite && channel.lifecycle == WorkspaceChannelLifecycle.ACTIVE) {
            CommunityCategoryPresentation.makeInviteScope(
                organisationId = organisationId,
                channelId = channel.id,
                channelName = channel.name,
            )
        } else {
            null
        }
    }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(
                modifier = Modifier.weight(1f).semantics(mergeDescendants = true) {},
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
            ) {
                Text(channel.name, style = NativeTypography.body)
                Text(stringResource(when (channel.kind) {
                    ChannelKind.TEXT -> R.string.workspace_channel_text
                    ChannelKind.AUDIO -> R.string.workspace_channel_audio
                }), style = NativeTypography.caption, color = palette.ink2)
                Text(stringResource(workspaceRoomLabel(channel.roomState)), style = NativeTypography.caption, color = palette.ink2)
                if (channel.lifecycle == WorkspaceChannelLifecycle.ARCHIVED) {
                    Text(stringResource(R.string.workspace_channel_archived), style = NativeTypography.caption, color = palette.ink3)
                }
            }
            if (inviteScope != null && onOpenInvite != null) {
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
    }
}

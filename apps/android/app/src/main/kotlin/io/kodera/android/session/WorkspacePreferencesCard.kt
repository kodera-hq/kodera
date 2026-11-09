package io.kodera.android.session

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.client.WorkspacePreferencesSession
import io.kodera.android.client.WorkspacePreferencesController
import io.kodera.android.client.WorkspacePreferencesScope
import io.kodera.android.domain.KoderaUserProfile
import io.kodera.android.domain.ChannelIamPolicy
import io.kodera.android.domain.DocsPadDraft
import io.kodera.android.domain.KODERA_MONOGRAM_BG_HEX
import io.kodera.android.domain.KoderaPresenceStatus
import io.kodera.android.domain.KoderaRoleRank
import io.kodera.android.domain.KoderaThemeMode
import io.kodera.android.domain.ShareableThemeCodec
import io.kodera.android.domain.ShareableThemeTokens
import io.kodera.android.domain.WorkspacePreferencesFailure
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Opt-in local guest simulation; no real member, rank or Docs service is provisioned. */
@Composable
internal fun WorkspacePreferencesCard(session: WorkspacePreferencesSession?, previewScope: WorkspacePreferencesScope?) {
    val localOwner = remember(previewScope, session) {
        if (session == null && previewScope != null) WorkspacePreferencesController(previewScope) else null
    }
    var localSession by remember(localOwner) { mutableStateOf<WorkspacePreferencesSession?>(null) }
    var activationFailed by remember(localOwner) { mutableStateOf(false) }
    val activeSession = session ?: localSession
    DisposableEffect(localOwner) { onDispose { localOwner?.stop() } }
    val localName = stringResource(R.string.preferences_local_member)
    val localRole = stringResource(R.string.preferences_guest)
    val localTitle = stringResource(R.string.preferences_untitled_draft)
    val palette = LocalKoderaPalette.current
    var state by remember(activeSession) { mutableStateOf(activeSession?.snapshot()) }
    DisposableEffect(activeSession) {
        val subscription = activeSession?.observe { state = it }
        onDispose { subscription?.close(); activeSession?.leave() }
    }
    fun update(action: (WorkspacePreferencesSession) -> Unit) {
        val current = activeSession ?: return
        try { action(current) } catch (_: WorkspacePreferencesFailure) { state = current.snapshot() }
    }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5), verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
                // Canonical monogram on invariant pure black, independent of imported palettes.
                Box(Modifier.background(Color(KODERA_MONOGRAM_BG_HEX), RoundedCornerShape(KoderaTokens.Radius.sm))
                    .padding(KoderaTokens.Space.s3), contentAlignment = Alignment.Center) {
                    Image(painterResource(R.drawable.kodera_monogram), contentDescription = stringResource(R.string.preferences_monogram),
                        modifier = Modifier.size(KoderaTokens.Space.s12))
                }
                Text(stringResource(R.string.preferences_title), style = NativeTypography.heading, modifier = Modifier.semantics { heading() })
            }
            Text(stringResource(R.string.preferences_disclosure), style = NativeTypography.body, color = palette.ink2)
            Text(stringResource(if (state == null) R.string.preferences_unprovisioned else R.string.preferences_local),
                style = NativeTypography.emphasis, color = palette.ink2, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (state == null && localOwner != null && previewScope != null) {
                OutlinedButton(onClick = {
                    try {
                        val profile = KoderaUserProfile(LOCAL_PREVIEW_USER_ID, localName, "local.preview", localRole,
                            KoderaPresenceStatus.OFFLINE, KoderaRoleRank.GUEST)
                        val document = DocsPadDraft("local-preview", previewScope.channelId, localTitle, "", 1, LOCAL_PREVIEW_USER_ID)
                        val context = localOwner.beginLocalPreview(profile, document)
                        localSession = WorkspacePreferencesSession(localOwner, context)
                        activationFailed = false
                    } catch (_: WorkspacePreferencesFailure) { activationFailed = true }
                }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.preferences_begin_preview), style = NativeTypography.emphasis, color = palette.accentInk)
                }
            }
            if (activationFailed) Text(stringResource(R.string.preferences_invalid), style = NativeTypography.caption,
                color = palette.ink2, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            state?.let { preview ->
                Text(stringResource(R.string.preferences_theme), style = NativeTypography.heading, modifier = Modifier.semantics { heading() })
                for (mode in KoderaThemeMode.entries) {
                    OutlinedButton(onClick = { update { it.selectThemeMode(mode) } },
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).semantics { selected = preview.themeMode == mode }) {
                        Text(stringResource(mode.labelResource), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                }
                for ((index, preset) in ShareableThemeCodec.CURATED_PRESETS.withIndex()) {
                    OutlinedButton(onClick = { update { it.applyPreset(preset.id) } },
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).semantics { selected = preview.activeThemeSpec.id == preset.id }) {
                        Text(stringResource(presetLabel(index)), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                }
                val tokens = preview.activeThemeSpec.tokens
                Surface(color = tokens.page.color(), contentColor = tokens.ink.color(), shape = RoundedCornerShape(KoderaTokens.Radius.md)) {
                    Column(Modifier.fillMaxWidth().padding(KoderaTokens.Space.s4), verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                        Text(stringResource(R.string.preferences_theme_sample), style = NativeTypography.body)
                        Surface(color = tokens.surface.color(), contentColor = tokens.ink.color()) {
                            Text(preview.activeThemeSpec.name, style = NativeTypography.emphasis, modifier = Modifier.padding(KoderaTokens.Space.s2))
                        }
                    }
                }
                OutlinedTextField(value = preview.shareCode, onValueChange = {}, readOnly = true,
                    label = { Text(stringResource(R.string.preferences_share)) }, modifier = Modifier.fillMaxWidth())
                var importCode by remember(activeSession) { mutableStateOf("") }
                OutlinedTextField(value = importCode, onValueChange = { if (bounded(it, ShareableThemeCodec.MAX_CODE_BYTES)) importCode = it },
                    label = { Text(stringResource(R.string.preferences_import_code)) }, modifier = Modifier.fillMaxWidth())
                OutlinedButton(onClick = { update { it.importShareCode(importCode) } }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.preferences_import), style = NativeTypography.emphasis, color = palette.accentInk)
                }
                preview.profile?.let { profile ->
                    Text(stringResource(R.string.preferences_profile), style = NativeTypography.heading, modifier = Modifier.semantics { heading() })
                    var name by remember(activeSession, profile) { mutableStateOf(profile.displayName) }
                    var handle by remember(activeSession, profile) { mutableStateOf(profile.handle) }
                    var roleTitle by remember(activeSession, profile) { mutableStateOf(profile.roleTitle) }
                    var presence by remember(activeSession, profile) { mutableStateOf(profile.presence) }
                    var rank by remember(activeSession, profile) { mutableStateOf(profile.rank) }
                    OutlinedTextField(value = name, onValueChange = { if (bounded(it, 64)) name = it }, label = { Text(stringResource(R.string.preferences_name)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = handle, onValueChange = { if (bounded(it, 32)) handle = it }, label = { Text(stringResource(R.string.preferences_handle)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = roleTitle, onValueChange = { if (bounded(it, 64)) roleTitle = it }, label = { Text(stringResource(R.string.preferences_role_title)) }, modifier = Modifier.fillMaxWidth())
                    for (value in KoderaPresenceStatus.entries) {
                        OutlinedButton(onClick = { presence = value }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).semantics { selected = presence == value }) {
                            Text(stringResource(value.labelResource), style = NativeTypography.emphasis, color = palette.accentInk)
                        }
                    }
                    Text(stringResource(R.string.preferences_rank_simulation), style = NativeTypography.caption, color = palette.ink2)
                    for (value in KoderaRoleRank.entries) {
                        OutlinedButton(onClick = { rank = value }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).semantics { selected = rank == value }) {
                            Text(stringResource(R.string.preferences_rank, stringResource(value.labelResource), value.powerLevel), style = NativeTypography.emphasis, color = palette.accentInk)
                        }
                    }
                    OutlinedButton(onClick = { update { it.updateProfile(name, handle, roleTitle, presence, rank) } }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                        Text(stringResource(R.string.preferences_save_profile), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                    Text(stringResource(R.string.preferences_profile_summary, profile.handle, profile.roleTitle, profile.rank.powerLevel), style = NativeTypography.body)
                    // A fixed local policy demonstrates ranks only. It never gates actual channel access.
                    val policy = ChannelIamPolicy(preview.scope.channelId, "local-preview", false, KoderaRoleRank.MEMBER,
                        KoderaRoleRank.MEMBER, KoderaRoleRank.ADMIN, true, false)
                    val access = runCatching { activeSession?.evaluateAccess(policy) }.getOrNull()
                    Column(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                        Text(stringResource(R.string.preferences_access, stringResource(R.string.preferences_read), stringResource(if (access?.canRead == true) R.string.preferences_allowed else R.string.preferences_denied)), style = NativeTypography.caption)
                        Text(stringResource(R.string.preferences_access, stringResource(R.string.preferences_write), stringResource(if (access?.canWrite == true) R.string.preferences_allowed else R.string.preferences_denied)), style = NativeTypography.caption)
                        Text(stringResource(R.string.preferences_access, stringResource(R.string.preferences_polls), stringResource(if (access?.canCreatePoll == true) R.string.preferences_allowed else R.string.preferences_denied)), style = NativeTypography.caption)
                        Text(stringResource(R.string.preferences_access, stringResource(R.string.preferences_manage), stringResource(if (access?.canManage == true) R.string.preferences_allowed else R.string.preferences_denied)), style = NativeTypography.caption)
                    }
                }
                preview.activeDocsPad?.let { document ->
                    Text(stringResource(R.string.preferences_docs), style = NativeTypography.heading, modifier = Modifier.semantics { heading() })
                    var title by remember(activeSession, document) { mutableStateOf(document.title) }
                    var body by remember(activeSession, document) { mutableStateOf(document.markdownBody) }
                    var showExport by remember(activeSession, document) { mutableStateOf(false) }
                    OutlinedTextField(value = title, onValueChange = { if (bounded(it, 120)) title = it }, label = { Text(stringResource(R.string.preferences_docs_title)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = body, onValueChange = { if (bounded(it, DocsPadDraft.MAX_BODY_BYTES)) body = it }, label = { Text(stringResource(R.string.preferences_markdown)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedButton(onClick = { update { it.updateDocsPad(title, body) } }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                        Text(stringResource(R.string.preferences_save_docs), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                    Text(stringResource(R.string.preferences_revision, document.revision), style = NativeTypography.caption, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    Text(document.markdownBody, style = NativeTypography.body)
                    OutlinedButton(onClick = { showExport = !showExport }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                        Text(stringResource(R.string.preferences_export_docs), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                    if (showExport) OutlinedTextField(value = document.exportMarkdown(), onValueChange = {}, readOnly = true,
                        label = { Text(stringResource(R.string.preferences_export_docs)) }, modifier = Modifier.fillMaxWidth())
                }
                if (preview.lastError != null) Text(stringResource(R.string.preferences_invalid), style = NativeTypography.caption,
                    color = palette.ink2, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
        }
    }
}

private fun bounded(value: String, maximum: Int) = value.length <= maximum && value.toByteArray(Charsets.UTF_8).size <= maximum
private fun String.color(): Color { val channels = ShareableThemeTokens.rgbComponents(this); return Color(channels[0], channels[1], channels[2]) }
private fun presetLabel(index: Int) = when (index) { 0 -> R.string.preferences_preset_black; 1 -> R.string.preferences_preset_cobalt; 2 -> R.string.preferences_preset_amber; else -> R.string.preferences_preset_forest }
private val KoderaThemeMode.labelResource: Int get() = when (this) { KoderaThemeMode.LIGHT -> R.string.preferences_light; KoderaThemeMode.DARK -> R.string.preferences_dark; KoderaThemeMode.BLACK -> R.string.preferences_black }
private val KoderaPresenceStatus.labelResource: Int get() = when (this) { KoderaPresenceStatus.ONLINE -> R.string.preferences_online; KoderaPresenceStatus.IDLE -> R.string.preferences_idle; KoderaPresenceStatus.DND -> R.string.preferences_dnd; KoderaPresenceStatus.OFFLINE -> R.string.preferences_offline }
private val KoderaRoleRank.labelResource: Int get() = when (this) { KoderaRoleRank.GUEST -> R.string.preferences_guest; KoderaRoleRank.MEMBER -> R.string.preferences_member; KoderaRoleRank.MODERATOR -> R.string.preferences_moderator; KoderaRoleRank.ADMIN -> R.string.preferences_admin; KoderaRoleRank.OWNER -> R.string.preferences_owner }

// A synthetic offline guest used only after explicit local-preview opt-in, never a Core identity.
private const val LOCAL_PREVIEW_USER_ID = "00000000-0000-4000-8000-000000000001"

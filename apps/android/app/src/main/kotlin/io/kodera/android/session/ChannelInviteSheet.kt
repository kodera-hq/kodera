package io.kodera.android.session

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.domain.FederatedMatrixPartnerClient
import io.kodera.android.domain.MatrixInvitationError
import io.kodera.android.domain.MatrixInvitationFailure
import io.kodera.android.domain.MatrixRoomAlias
import io.kodera.android.domain.MatrixRoomId
import io.kodera.android.domain.MatrixServerName
import io.kodera.android.domain.MatrixUserId
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.UniversalMatrixInvitation
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

enum class ChannelInviteError {
    INVALID_SCOPE,
    STALE_CONTEXT,
    STOPPED,
    INVALID_RECIPIENT,
    TRANSPORT_FAILED,
}

class ChannelInviteFailure(
    val reason: ChannelInviteError,
    val recipientError: MatrixInvitationError? = null,
) : Exception(reason.name)

enum class ChannelInviteShareFormat {
    MATRIX_TO_URL,
    MATRIX_URI,
    CANONICAL_ALIAS,
}

sealed interface ChannelInviteStatus {
    data object Idle : ChannelInviteStatus
    data class Sent(val recipient: MatrixUserId) : ChannelInviteStatus
    data class Unprovisioned(val recipient: MatrixUserId) : ChannelInviteStatus
    data class Failed(val error: ChannelInviteError) : ChannelInviteStatus
}

fun interface MatrixRoomInviteTransport {
    fun sendRoomInvite(
        organisationId: String,
        roomIdentifier: String,
        recipient: MatrixUserId,
    )
}

/** Scoped channel metadata constructing canonical Matrix invitation URIs without any literal URL in `:app`. */
@ConsistentCopyVisibility
data class ChannelInviteScope private constructor(
    val organisationId: String,
    val channelId: String,
    val channelName: String,
    val serverName: MatrixServerName,
    val canonicalAlias: MatrixRoomAlias?,
    val roomId: MatrixRoomId?,
    val invitation: UniversalMatrixInvitation,
) {
    val hasProvisionedRoomTarget: Boolean
        get() = canonicalAlias != null || roomId != null

    val roomTargetIdentifier: String?
        get() = roomId?.rawValue ?: canonicalAlias?.rawValue

    companion object {
        fun create(
            organisationId: String,
            channelId: String,
            channelName: String,
            serverName: MatrixServerName,
            canonicalAlias: MatrixRoomAlias? = null,
            roomId: MatrixRoomId? = null,
        ): ChannelInviteScope {
            if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
                !isBoundedLabel(channelId) ||
                !isBoundedLabel(channelName)
            ) {
                throw ChannelInviteFailure(ChannelInviteError.INVALID_SCOPE)
            }
            val invitation = try {
                when {
                    roomId != null -> UniversalMatrixInvitation.forRoom(
                        roomId = roomId,
                        canonicalAlias = canonicalAlias,
                        channelSlug = channelName,
                        serverName = serverName,
                    )
                    canonicalAlias != null -> UniversalMatrixInvitation.forRoomAlias(
                        alias = canonicalAlias,
                        via = listOf(serverName),
                    )
                    else -> UniversalMatrixInvitation.forRoomAlias(
                        alias = MatrixRoomAlias.suggested(channelName, serverName),
                        via = listOf(serverName),
                    )
                }
            } catch (_: MatrixInvitationFailure) {
                throw ChannelInviteFailure(ChannelInviteError.INVALID_SCOPE)
            }
            return ChannelInviteScope(
                organisationId = organisationId,
                channelId = channelId,
                channelName = channelName,
                serverName = serverName,
                canonicalAlias = canonicalAlias,
                roomId = roomId,
                invitation = invitation,
            )
        }

        private fun isBoundedLabel(value: String): Boolean {
            if (value.isBlank() || value != value.trim()) return false
            val utf8 = value.toByteArray(Charsets.UTF_8)
            if (utf8.size !in 1..256 || String(utf8, Charsets.UTF_8) != value) return false
            return value.none { Character.isISOControl(it) }
        }
    }
}

/** Opaque operation fence preventing stale invite sheets from mutating newer scopes. */
class ChannelInviteContext internal constructor(
    private val owner: Any,
    private val generation: Long,
    val scope: ChannelInviteScope,
) {
    internal fun matches(expectedOwner: Any, expectedGeneration: Long, expectedScope: ChannelInviteScope?): Boolean =
        owner === expectedOwner && generation == expectedGeneration && scope == expectedScope
}

/**
 * Coordinates in-app universal Matrix share links and validated `@localpart:domain` direct invites.
 * Never opens external URLs; reports `Unprovisioned` honestly when live Matrix room transport is absent.
 */
class ChannelInviteCoordinator(
    private val inviteTransport: MatrixRoomInviteTransport? = null,
) {
    private val owner = Any()
    private var generation: Long = 1L
    private var stopped = false

    var activeScope by mutableStateOf<ChannelInviteScope?>(null)
        private set

    var status by mutableStateOf<ChannelInviteStatus>(ChannelInviteStatus.Idle)
        private set

    var lastCopiedFormat by mutableStateOf<ChannelInviteShareFormat?>(null)
        private set

    @Synchronized
    fun configureOrganisation(organisationId: String?) {
        if (stopped) return
        if (organisationId == null || activeScope?.organisationId != organisationId) {
            activeScope = null
            status = ChannelInviteStatus.Idle
            lastCopiedFormat = null
            generation += 1L
        }
    }

    @Synchronized
    fun openSheet(scope: ChannelInviteScope): ChannelInviteContext {
        if (stopped) throw ChannelInviteFailure(ChannelInviteError.STOPPED)
        generation += 1L
        activeScope = scope
        status = ChannelInviteStatus.Idle
        lastCopiedFormat = null
        return ChannelInviteContext(owner, generation, scope)
    }

    @Synchronized
    fun isCurrentContext(context: ChannelInviteContext?): Boolean =
        !stopped && context != null && activeScope != null && context.matches(owner, generation, activeScope)

    @Synchronized
    fun dismissSheet(context: ChannelInviteContext?) {
        if (stopped) return
        if (context == null || context.matches(owner, generation, activeScope)) {
            activeScope = null
            status = ChannelInviteStatus.Idle
            lastCopiedFormat = null
            generation += 1L
        }
    }

    @Synchronized
    fun shareText(format: ChannelInviteShareFormat, context: ChannelInviteContext): String {
        val current = requireValidContext(context)
        return when (format) {
            ChannelInviteShareFormat.MATRIX_TO_URL -> current.invitation.matrixToUrlString
            ChannelInviteShareFormat.MATRIX_URI -> current.invitation.matrixUriString
            ChannelInviteShareFormat.CANONICAL_ALIAS ->
                current.invitation.displayAlias ?: current.invitation.canonicalIdentifier
        }
    }

    @Synchronized
    fun copyInvitation(
        format: ChannelInviteShareFormat,
        context: ChannelInviteContext,
        copySink: (String) -> Unit,
    ): String {
        val value = shareText(format, context)
        copySink(value)
        lastCopiedFormat = format
        return value
    }

    @Synchronized
    fun sendDirectInvite(
        rawMatrixUserId: String,
        context: ChannelInviteContext,
    ): ChannelInviteStatus {
        val current = requireValidContext(context)
        val trimmed = rawMatrixUserId.trim()
        val recipient = try {
            MatrixUserId.parse(trimmed)
        } catch (failure: MatrixInvitationFailure) {
            status = ChannelInviteStatus.Failed(ChannelInviteError.INVALID_RECIPIENT)
            throw ChannelInviteFailure(ChannelInviteError.INVALID_RECIPIENT, failure.reason)
        }

        val roomTarget = current.roomTargetIdentifier
        val transport = inviteTransport
        if (roomTarget == null || transport == null) {
            status = ChannelInviteStatus.Unprovisioned(recipient)
            return status
        }

        try {
            transport.sendRoomInvite(current.organisationId, roomTarget, recipient)
            status = ChannelInviteStatus.Sent(recipient)
            return status
        } catch (_: Throwable) {
            status = ChannelInviteStatus.Failed(ChannelInviteError.TRANSPORT_FAILED)
            throw ChannelInviteFailure(ChannelInviteError.TRANSPORT_FAILED)
        }
    }

    @Synchronized
    fun stop() {
        if (stopped) return
        stopped = true
        activeScope = null
        status = ChannelInviteStatus.Idle
        lastCopiedFormat = null
        generation += 1L
    }

    private fun requireValidContext(context: ChannelInviteContext): ChannelInviteScope {
        if (stopped) throw ChannelInviteFailure(ChannelInviteError.STOPPED)
        val current = activeScope ?: throw ChannelInviteFailure(ChannelInviteError.STALE_CONTEXT)
        if (!context.matches(owner, generation, current)) {
            throw ChannelInviteFailure(ChannelInviteError.STALE_CONTEXT)
        }
        return current
    }
}

/**
 * In-app `ModalBottomSheet` presenting canonical `matrix.to`, `matrix:r/...`, `#alias:domain`,
 * and validated `@localpart:domain` direct invitations with injectable copy callback.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ChannelInviteSheet(
    scope: ChannelInviteScope,
    coordinator: ChannelInviteCoordinator,
    context: ChannelInviteContext,
    onDismiss: () -> Unit,
    onCopyText: ((String) -> Unit)? = null,
) {
    val palette = LocalKoderaPalette.current
    val androidContext = LocalContext.current
    val clipboardLabel = stringResource(R.string.invite_clipboard_label)
    val effectiveCopySink: (String) -> Unit = onCopyText ?: { text ->
        androidContext.getSystemService(ClipboardManager::class.java)
            ?.setPrimaryClip(ClipData.newPlainText(clipboardLabel, text))
    }

    var directRecipientInput by remember(scope) { mutableStateOf("") }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = palette.elevated,
        contentColor = palette.ink,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth()
                .padding(horizontal = KoderaTokens.Space.s6, vertical = KoderaTokens.Space.s4),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
        ) {
            Text(
                stringResource(R.string.invite_sheet_title, scope.channelName),
                style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                stringResource(R.string.invite_sheet_subtitle),
                style = NativeTypography.caption,
                color = palette.ink2,
            )

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                for (partner in FederatedMatrixPartnerClient.entries) {
                    CielBadgePill(
                        label = partner.displayName,
                        containerColor = palette.tag1Bg,
                        contentColor = palette.tag1Fg,
                    )
                }
            }

            InviteFormatRow(
                label = stringResource(R.string.invite_format_matrix_uri),
                value = scope.invitation.matrixUriString,
                actionLabel = stringResource(R.string.invite_action_copy_uri),
                onCopy = {
                    runCatching {
                        coordinator.copyInvitation(ChannelInviteShareFormat.MATRIX_URI, context, effectiveCopySink)
                    }
                },
            )

            InviteFormatRow(
                label = stringResource(R.string.invite_format_matrix_to),
                value = scope.invitation.matrixToUrlString,
                actionLabel = stringResource(R.string.invite_action_copy_web),
                onCopy = {
                    runCatching {
                        coordinator.copyInvitation(ChannelInviteShareFormat.MATRIX_TO_URL, context, effectiveCopySink)
                    }
                },
            )

            val aliasValue = scope.invitation.displayAlias ?: scope.invitation.canonicalIdentifier
            InviteFormatRow(
                label = stringResource(
                    if (scope.invitation.isSuggestedAlias) R.string.invite_format_suggested_alias
                    else R.string.invite_format_canonical_alias
                ),
                value = aliasValue,
                actionLabel = stringResource(R.string.invite_action_copy_alias),
                onCopy = {
                    runCatching {
                        coordinator.copyInvitation(ChannelInviteShareFormat.CANONICAL_ALIAS, context, effectiveCopySink)
                    }
                },
            )

            coordinator.lastCopiedFormat?.let { copiedFormat ->
                val copiedLabel = when (copiedFormat) {
                    ChannelInviteShareFormat.MATRIX_URI -> R.string.invite_copied_uri
                    ChannelInviteShareFormat.MATRIX_TO_URL -> R.string.invite_copied_web
                    ChannelInviteShareFormat.CANONICAL_ALIAS -> R.string.invite_copied_alias
                }
                Text(
                    stringResource(copiedLabel),
                    style = NativeTypography.caption,
                    color = palette.okInk,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            HorizontalDivider(color = palette.borderSoft)

            Text(
                stringResource(R.string.invite_direct_heading),
                style = NativeTypography.emphasis,
                modifier = Modifier.semantics { heading() },
            )
            OutlinedTextField(
                value = directRecipientInput,
                onValueChange = { directRecipientInput = it },
                singleLine = true,
                label = { Text(stringResource(R.string.invite_direct_label)) },
                placeholder = { Text(stringResource(R.string.invite_direct_placeholder)) },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = {
                    try {
                        coordinator.sendDirectInvite(directRecipientInput, context)
                    } catch (_: ChannelInviteFailure) {
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
            ) {
                Text(
                    stringResource(R.string.invite_direct_submit),
                    style = NativeTypography.emphasis,
                    color = palette.accentInk,
                )
            }

            when (val inviteStatus = coordinator.status) {
                ChannelInviteStatus.Idle -> Unit
                is ChannelInviteStatus.Sent -> Text(
                    stringResource(R.string.invite_status_sent, inviteStatus.recipient.rawValue),
                    style = NativeTypography.caption,
                    color = palette.okInk,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                is ChannelInviteStatus.Unprovisioned -> Text(
                    stringResource(R.string.invite_status_unprovisioned, inviteStatus.recipient.rawValue),
                    style = NativeTypography.caption,
                    color = palette.ink2,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                is ChannelInviteStatus.Failed -> Text(
                    stringResource(
                        if (inviteStatus.error == ChannelInviteError.INVALID_RECIPIENT) {
                            R.string.invite_status_invalid_recipient
                        } else {
                            R.string.invite_status_failed
                        }
                    ),
                    style = NativeTypography.caption,
                    color = palette.badInk,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                OutlinedButton(
                    onClick = onDismiss,
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(stringResource(R.string.invite_action_close), style = NativeTypography.emphasis, color = palette.ink)
                }
            }
        }
    }
}

@Composable
private fun InviteFormatRow(
    label: String,
    value: String,
    actionLabel: String,
    onCopy: () -> Unit,
) {
    val palette = LocalKoderaPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1)) {
        Text(label, style = NativeTypography.caption, color = palette.ink3)
        Text(value, style = NativeTypography.monoCaption, color = palette.ink)
        OutlinedButton(
            onClick = onCopy,
            modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s10),
        ) {
            Text(actionLabel, style = NativeTypography.caption, color = palette.accentInk)
        }
    }
}

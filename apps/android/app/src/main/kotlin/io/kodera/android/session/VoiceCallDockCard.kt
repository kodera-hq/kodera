package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import io.kodera.android.R
import io.kodera.android.client.VoiceCallDockSession
import io.kodera.android.domain.VoiceCallFailure
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Controls affect local preview preferences only; no microphone or remote audio is provisioned. */
@Composable
internal fun VoiceCallDockCard(session: VoiceCallDockSession?) {
    val palette = LocalKoderaPalette.current
    var state by remember(session) { mutableStateOf(session?.snapshot()) }
    DisposableEffect(session) {
        val subscription = session?.observe { state = it }
        onDispose { subscription?.close(); session?.leave() }
    }
    val muted = state?.isMuted ?: true
    val deafened = state?.isDeafened ?: false
    val muteState = stringResource(if (muted) R.string.voice_muted else R.string.voice_unmuted)
    val deafenState = stringResource(if (deafened) R.string.voice_deafened else R.string.voice_not_deafened)
    val muteHint = stringResource(R.string.voice_mute_hint)
    val deafenHint = stringResource(R.string.voice_deafen_hint)
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Text(stringResource(R.string.voice_title), style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.voice_unprovisioned), style = NativeTypography.body, color = palette.ink2)
            Text(stringResource(if (state == null) R.string.voice_unavailable else R.string.voice_preview_only),
                style = NativeTypography.caption, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            OutlinedButton(enabled = state != null, onClick = {
                try { session?.setMuted(!muted) } catch (_: VoiceCallFailure) { state = session?.snapshot() }
            }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                .semantics { stateDescription = muteState; contentDescription = muteHint }) {
                Text(stringResource(if (muted) R.string.voice_unmute else R.string.voice_mute),
                    style = NativeTypography.emphasis, color = palette.accentInk)
            }
            OutlinedButton(enabled = state != null, onClick = {
                try { session?.setDeafened(!deafened) } catch (_: VoiceCallFailure) { state = session?.snapshot() }
            }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                .semantics { stateDescription = deafenState; contentDescription = deafenHint }) {
                Text(stringResource(if (deafened) R.string.voice_undeafen else R.string.voice_deafen),
                    style = NativeTypography.emphasis, color = palette.accentInk)
            }
            state?.let { preview ->
                Text(stringResource(R.string.voice_preview_roster), style = NativeTypography.emphasis,
                    modifier = Modifier.semantics { heading() })
                for (participant in preview.participants) {
                    Column(modifier = Modifier.semantics(mergeDescendants = true) {},
                        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                        Text(participant.displayName, style = NativeTypography.body)
                        Text(stringResource(when {
                            participant.isSpeaking -> R.string.voice_participant_speaking
                            participant.isMuted -> R.string.voice_participant_muted
                            else -> R.string.voice_participant_unmuted
                        }), style = NativeTypography.caption, color = palette.ink2)
                    }
                }
                OutlinedButton(onClick = { session?.leave() },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.voice_leave_preview), style = NativeTypography.emphasis, color = palette.accentInk)
                }
            }
        }
    }
}

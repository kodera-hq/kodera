package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import io.kodera.android.R
import io.kodera.android.client.SoundPreferencesSession
import io.kodera.android.domain.SoundPackId
import io.kodera.android.domain.SoundPreferencesFailure
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens
import kotlin.math.roundToInt

/** Local preview preferences only. No sound is synthesized, played, persisted or transmitted. */
@Composable
internal fun SoundPreferencesCard(session: SoundPreferencesSession?) {
    val palette = LocalKoderaPalette.current
    var state by remember(session) { mutableStateOf(session?.snapshot()) }
    DisposableEffect(session) {
        val subscription = session?.observe { state = it }
        onDispose { subscription?.close(); session?.leave() }
    }
    fun update(action: (SoundPreferencesSession) -> Unit) {
        val current = session ?: return
        try { action(current) } catch (_: SoundPreferencesFailure) { state = current.snapshot() }
    }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Text(stringResource(R.string.sound_title), style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.sound_disclosure), style = NativeTypography.body, color = palette.ink2)
            Text(stringResource(if (state == null) R.string.sound_unprovisioned else R.string.sound_preview_only),
                style = NativeTypography.caption, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            state?.let { preview ->
                Text(stringResource(R.string.sound_pack), style = NativeTypography.emphasis,
                    modifier = Modifier.semantics { heading() })
                Column(modifier = Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    for (pack in SoundPackId.entries) {
                        OutlinedButton(onClick = { update { it.selectPack(pack) } },
                            modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                                .semantics { selected = preview.activePack == pack }) {
                            Text(stringResource(pack.labelResource), style = NativeTypography.emphasis, color = palette.accentInk)
                        }
                    }
                }
                val volumeLabel = stringResource(R.string.sound_volume)
                val volumeValue = stringResource(R.string.sound_percent, preview.volumePercent)
                Text(volumeLabel, style = NativeTypography.emphasis)
                Text(volumeValue, style = NativeTypography.body, color = palette.ink2)
                Slider(value = preview.volumePercent.toFloat(), onValueChange = { value ->
                    if (value.isFinite()) update { it.setVolumePercent(value.roundToInt()) }
                }, valueRange = 0f..100f, steps = 99,
                    modifier = Modifier.fillMaxWidth().semantics {
                        contentDescription = volumeLabel
                        stateDescription = volumeValue
                    })
                Row(modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                    .toggleable(value = preview.isManuallyMuted, role = Role.Checkbox,
                        onValueChange = { value -> update { it.setMuted(value) } }),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    Checkbox(checked = preview.isManuallyMuted, onCheckedChange = null)
                    Column {
                        Text(stringResource(R.string.sound_manual_mute), style = NativeTypography.emphasis)
                        Text(stringResource(R.string.sound_manual_mute_hint), style = NativeTypography.caption, color = palette.ink2)
                    }
                }
                Row(modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                    .toggleable(value = preview.isCallDuckingActive, role = Role.Checkbox,
                        onValueChange = { value -> update { it.setCallDucking(value) } }),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    Checkbox(checked = preview.isCallDuckingActive, onCheckedChange = null)
                    Column {
                        Text(stringResource(R.string.sound_call_ducking), style = NativeTypography.emphasis)
                        Text(stringResource(R.string.sound_call_ducking_hint), style = NativeTypography.caption, color = palette.ink2)
                    }
                }
                Column(modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    Text(stringResource(if (preview.isMuted) R.string.sound_output_muted else R.string.sound_output_enabled),
                        style = NativeTypography.body, color = palette.ink2)
                    Text(stringResource(R.string.sound_effective_gain, preview.effectiveGainPercent),
                        style = NativeTypography.caption, color = palette.ink2)
                    Text(stringResource(R.string.sound_active_ducking, preview.activeDuckingDecibels),
                        style = NativeTypography.caption, color = palette.ink2)
                }
            }
        }
    }
}

private val SoundPackId.labelResource: Int get() = when (this) {
    SoundPackId.GIVRE -> R.string.sound_pack_givre
    SoundPackId.CRISTAL -> R.string.sound_pack_cristal
    SoundPackId.ATELIER -> R.string.sound_pack_atelier
    SoundPackId.ARCADE_8BIT -> R.string.sound_pack_8bit
    SoundPackId.GLITCH_404 -> R.string.sound_pack_404
    SoundPackId.SILENT -> R.string.sound_pack_silent
}

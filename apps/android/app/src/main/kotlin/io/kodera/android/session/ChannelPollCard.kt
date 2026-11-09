package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.client.ChannelPollSession
import io.kodera.android.domain.ChannelPollFailure
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Explicit one-voter local preview; no remote poll, membership or server vote is fabricated. */
@Composable
internal fun ChannelPollCard(session: ChannelPollSession?) {
    val palette = LocalKoderaPalette.current
    var state by remember(session) { mutableStateOf(session?.snapshot()) }
    DisposableEffect(session) {
        val subscription = session?.observe { state = it }
        onDispose { subscription?.close(); session?.leave() }
    }
    fun update(action: (ChannelPollSession) -> Unit) {
        val current = session ?: return
        try { action(current) } catch (_: ChannelPollFailure) { state = current.snapshot() }
    }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Text(stringResource(R.string.poll_title), style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.poll_disclosure), style = NativeTypography.body, color = palette.ink2)
            Text(stringResource(if (state == null) R.string.poll_unprovisioned else R.string.poll_preview_only),
                style = NativeTypography.caption, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            state?.let { poll ->
                Text(poll.question, style = NativeTypography.emphasis, modifier = Modifier.semantics { heading() })
                Text(stringResource(if (poll.allowsMultipleChoices) R.string.poll_multiple else R.string.poll_single),
                    style = NativeTypography.caption, color = palette.ink2)
                Column(modifier = if (poll.allowsMultipleChoices) Modifier else Modifier.selectableGroup(),
                    verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    for (option in poll.options) {
                        val result = stringResource(R.string.poll_option_result, option.voteCount, option.percentage)
                        val action = if (poll.allowsMultipleChoices) Modifier.toggleable(
                            value = option.isSelectedByCurrentUser, enabled = !poll.isClosed, role = Role.Checkbox,
                            onValueChange = { update { it.toggleOption(option.id) } })
                        else Modifier.selectable(selected = option.isSelectedByCurrentUser, enabled = !poll.isClosed,
                            role = Role.RadioButton, onClick = { update { it.toggleOption(option.id) } })
                        Row(modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).then(action),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                            if (poll.allowsMultipleChoices) Checkbox(checked = option.isSelectedByCurrentUser,
                                onCheckedChange = null, enabled = !poll.isClosed)
                            else RadioButton(selected = option.isSelectedByCurrentUser, onClick = null, enabled = !poll.isClosed)
                            // The interactive Row owns label/results semantics; no nested merge boundary.
                            Column {
                                Text(option.label, style = NativeTypography.body)
                                Text(result, style = NativeTypography.caption, color = palette.ink2)
                            }
                        }
                    }
                }
                Column(modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                    Text(stringResource(R.string.poll_voters, poll.totalVotes), style = NativeTypography.body, color = palette.ink2)
                    Text(stringResource(if (poll.isClosed) R.string.poll_closed else R.string.poll_open),
                        style = NativeTypography.caption, color = palette.ink2)
                }
                if (!poll.isClosed) OutlinedButton(onClick = { update { it.closePoll() } },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.poll_close), style = NativeTypography.emphasis, color = palette.accentInk)
                }
                OutlinedButton(onClick = { session?.leave() }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.poll_leave), style = NativeTypography.emphasis, color = palette.accentInk)
                }
            }
        }
    }
}

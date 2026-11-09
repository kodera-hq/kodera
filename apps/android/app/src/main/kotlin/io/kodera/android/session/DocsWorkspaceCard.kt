package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.client.DocsWorkspaceSession
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Metadata only: no link action, WebView, fetch or fabricated Docs service connection. */
@Composable
internal fun DocsWorkspaceCard(session: DocsWorkspaceSession?) {
    val palette = LocalKoderaPalette.current
    var state by remember(session) { mutableStateOf(session?.snapshot()) }
    DisposableEffect(session) {
        val subscription = session?.observe { state = it }
        onDispose { subscription?.close(); session?.leave() }
    }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Text(stringResource(R.string.docs_title), style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.docs_disclosure), style = NativeTypography.body, color = palette.ink2)
            Text(stringResource(if (state == null) R.string.docs_unprovisioned else R.string.docs_preview_only),
                style = NativeTypography.caption, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            state?.let { preview ->
                for (pad in preview.pads) {
                    Column(modifier = Modifier.semantics(mergeDescendants = true) {},
                        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                        Text(pad.title, style = NativeTypography.emphasis)
                        Text(stringResource(R.string.docs_address), style = NativeTypography.caption, color = palette.ink3)
                        Text(pad.host + pad.path, style = NativeTypography.body, color = palette.ink2)
                    }
                }
            }
        }
    }
}

package io.kodera.android.entry

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import io.kodera.android.R
import io.kodera.android.client.AnonymousDiscoveryState
import io.kodera.android.client.DiscoveryPresentation
import io.kodera.android.client.TransportFailure
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

@Composable
fun OrganisationEntryScreen(
    state: OrganisationEntryState,
    onSlugChanged: (String) -> Unit,
    onLookup: () -> Unit,
    onClear: () -> Unit,
    onCancel: () -> Unit,
    onSelect: (String) -> Unit,
    signIn: SignInPanel = SignInPanel(),
    onSignIn: (issuer: String) -> Unit = {},
    onCancelSignIn: () -> Unit = {},
) {
    val palette = LocalKoderaPalette.current
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val message = stringResource(messageId(state.discovery))
    val submit = { if (state.canLookup) { keyboard?.hide(); focusManager.clearFocus(); onLookup() } }
    Surface(modifier = Modifier.fillMaxSize(), color = palette.page, contentColor = palette.ink) {
        Box(
            modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier.widthIn(max = KoderaTokens.Space.shellDocumentMinWidth)
                    .fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = KoderaTokens.Space.s6, vertical = KoderaTokens.Space.s8),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s8),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
                    Text(stringResource(R.string.brand_name), style = NativeTypography.wordmark, color = palette.action, modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.welcome_title), style = NativeTypography.title, modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.welcome_description), style = NativeTypography.body, color = palette.ink2)
                }
                Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
                    Column(
                        modifier = Modifier.padding(KoderaTokens.Space.s5),
                        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s5),
                    ) {
                        Text(stringResource(R.string.organisation_title), style = NativeTypography.heading, modifier = Modifier.semantics { heading() })
                        OutlinedTextField(
                            value = state.organisationSlug,
                            onValueChange = onSlugChanged,
                            label = { Text(stringResource(R.string.organisation_label)) },
                            placeholder = { Text(stringResource(R.string.organisation_placeholder)) },
                            supportingText = { Text(stringResource(if (state.organisationSlug.isNotEmpty() && !state.canonicalSlug) R.string.discovery_input_rules else R.string.organisation_hint), style = NativeTypography.caption) },
                            isError = state.organisationSlug.isNotEmpty() && !state.canonicalSlug,
                            textStyle = NativeTypography.body,
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.None,
                                autoCorrectEnabled = false,
                                keyboardType = KeyboardType.Ascii,
                                imeAction = ImeAction.Search,
                            ),
                            keyboardActions = KeyboardActions(onSearch = { submit() }),
                            modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).focusRequester(focus),
                        )
                        if (state.isLoading) {
                            // Silent to TalkBack: the live status below says it. accentInk: 3:1 on every surface.
                            CircularProgressIndicator(modifier = Modifier.size(KoderaTokens.Space.s6).clearAndSetSemantics {},
                                color = palette.accentInk)
                            Button(onClick = onCancel, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                                Text(stringResource(R.string.discovery_cancel), style = NativeTypography.emphasis)
                            }
                        } else {
                            Button(onClick = submit, enabled = state.canLookup,
                                modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12).semantics { stateDescription = message }) {
                                Text(stringResource(R.string.discovery_action), style = NativeTypography.emphasis)
                            }
                        }
                        TextButton(onClick = { onClear(); focus.requestFocus() }, enabled = state.organisationSlug.isNotEmpty(),
                            modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                            // accentInk, not action: action on surface is under 4.5:1 in the dark palettes.
                            Text(stringResource(R.string.input_clear), style = NativeTypography.body,
                                color = if (state.organisationSlug.isNotEmpty()) palette.accentInk else palette.ink3)
                        }
                    }
                }
                Column(
                    modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3),
                ) {
                    Text(stringResource(titleId(state.discovery)), style = NativeTypography.emphasis)
                    Text(message, style = NativeTypography.body, color = palette.ink2)
                    if (!signIn.configured) {
                        Text(stringResource(R.string.login_unavailable), style = NativeTypography.caption, color = palette.ink3)
                    }
                }
                when (val discovery = state.discovery) {
                    is AnonymousDiscoveryState.Choosing -> discovery.choices.forEach { organisation ->
                        key(organisation.organisationId) {
                            Button(onClick = { keyboard?.hide(); focusManager.clearFocus(); onSelect(organisation.organisationId) },
                                enabled = state.active, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                                Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                                    Text(organisation.displayName, style = NativeTypography.emphasis)
                                    Text(organisation.organisationSlug, style = NativeTypography.caption)
                                }
                            }
                        }
                    }
                    is AnonymousDiscoveryState.Selected -> Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.md)) {
                        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s4), verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                            Text(discovery.metadata.displayName, style = NativeTypography.heading)
                            Text(discovery.metadata.organisationSlug, style = NativeTypography.caption, color = palette.ink2)
                        }
                    }
                    else -> Unit
                }
                SignInSection(signIn, DiscoveryPresentation.of(state.discovery).signInIssuer,
                    onSignIn = { issuer -> keyboard?.hide(); focusManager.clearFocus(); onSignIn(issuer) },
                    onCancel = onCancelSignIn)
            }
        }
    }
}

/** What organisation entry needs to know about sign-in; it holds no session or token. */
data class SignInPanel(
    val configured: Boolean = false,
    val canSignIn: Boolean = false,
    val signingIn: Boolean = false,
    /** Debug builds only: the local realm issuer offered without Core discovery. */
    val developmentIssuer: String? = null,
    @StringRes val notice: Int? = null,
)

@Composable
private fun SignInSection(panel: SignInPanel, selectedIssuer: String?, onSignIn: (String) -> Unit, onCancel: () -> Unit) {
    val palette = LocalKoderaPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3)) {
        if (panel.signingIn) {
            // The text says it once; the spinner itself is silent to TalkBack.
            CircularProgressIndicator(modifier = Modifier.size(KoderaTokens.Space.s6).clearAndSetSemantics {},
                color = palette.accentInk)
            Text(stringResource(R.string.signin_in_progress), style = NativeTypography.body, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            // Always reachable: a browser step that never answers must not leave the member stuck here.
            OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                Text(stringResource(R.string.signin_cancel), style = NativeTypography.emphasis, color = palette.accentInk)
            }
        } else if (panel.canSignIn) {
            if (selectedIssuer != null) {
                Button(onClick = { onSignIn(selectedIssuer) }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.signin_action), style = NativeTypography.emphasis)
                }
                Text(stringResource(R.string.signin_hint), style = NativeTypography.caption, color = palette.ink3)
            }
            panel.developmentIssuer?.let { issuer ->
                OutlinedButton(onClick = { onSignIn(issuer) }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                    Text(stringResource(R.string.signin_development), style = NativeTypography.emphasis, color = palette.accentInk)
                }
                Text(stringResource(R.string.signin_development_hint), style = NativeTypography.caption, color = palette.ink3)
            }
        }
        panel.notice?.let { notice ->
            Text(stringResource(notice), style = NativeTypography.body, color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}

/** Typed entry states: no organisation found, try again later, network error, several candidates. */
private fun titleId(state: AnonymousDiscoveryState): Int = when (DiscoveryPresentation.of(state)) {
    DiscoveryPresentation.Ready -> R.string.discovery_status_ready
    DiscoveryPresentation.Searching -> R.string.discovery_status_loading
    DiscoveryPresentation.NoOrganisation -> R.string.discovery_status_no_match
    DiscoveryPresentation.Cancelled -> R.string.discovery_status_cancelled
    is DiscoveryPresentation.SeveralCandidates -> R.string.discovery_status_choose
    is DiscoveryPresentation.Found -> R.string.discovery_status_selected
    DiscoveryPresentation.TryAgainLater -> R.string.discovery_status_try_later
    is DiscoveryPresentation.NetworkError -> R.string.discovery_status_network
    DiscoveryPresentation.ServiceUnavailable, DiscoveryPresentation.RequestRefused, DiscoveryPresentation.InvalidResponse,
    DiscoveryPresentation.InvalidInput, DiscoveryPresentation.NotConfigured -> R.string.discovery_status_unavailable
}
private fun messageId(state: AnonymousDiscoveryState): Int = when (val presentation = DiscoveryPresentation.of(state)) {
    DiscoveryPresentation.Ready -> R.string.discovery_ready
    DiscoveryPresentation.Searching -> R.string.discovery_loading
    DiscoveryPresentation.NoOrganisation -> R.string.discovery_no_match
    DiscoveryPresentation.Cancelled -> R.string.discovery_cancelled
    is DiscoveryPresentation.SeveralCandidates -> R.string.discovery_choose
    is DiscoveryPresentation.Found -> R.string.discovery_selected_explanation
    // A quota answer is never retried by the app: the member searches again later.
    DiscoveryPresentation.TryAgainLater -> R.string.discovery_rate_limited
    is DiscoveryPresentation.NetworkError -> when (presentation.reason) {
        TransportFailure.TIMEOUT -> R.string.discovery_timeout
        TransportFailure.OFFLINE -> R.string.discovery_offline
        TransportFailure.TLS, TransportFailure.AUTHENTICATION_CHALLENGE, TransportFailure.OTHER -> R.string.discovery_connection_unavailable
    }
    DiscoveryPresentation.ServiceUnavailable -> R.string.discovery_service_unavailable
    DiscoveryPresentation.RequestRefused -> R.string.discovery_request_refused
    DiscoveryPresentation.InvalidResponse -> R.string.discovery_invalid_response
    DiscoveryPresentation.InvalidInput -> R.string.discovery_input_rules
    DiscoveryPresentation.NotConfigured -> R.string.discovery_unavailable
}

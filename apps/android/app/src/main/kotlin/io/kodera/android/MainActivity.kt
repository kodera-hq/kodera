package io.kodera.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import io.kodera.android.auth.AuthorizationPresenter
import io.kodera.android.auth.carriesAuthorizationResult
import io.kodera.android.entry.OrganisationEntryScreen
import io.kodera.android.entry.OrganisationEntryViewModel
import io.kodera.android.entry.SignInPanel
import io.kodera.android.session.RestoringScreen
import io.kodera.android.session.SessionController
import io.kodera.android.session.SessionPhase
import io.kodera.android.session.SignedInScreen
import io.kodera.android.ui.theme.KoderaTheme

class MainActivity : ComponentActivity() {
    private lateinit var model: OrganisationEntryViewModel
    private lateinit var session: SessionController
    private val lifecycleToken = Any()

    // Registered before STARTED, so a result survives this Activity being recreated while the browser is
    // open. The controller outlives the Activity; after a process death it says the sign-in was interrupted.
    private val authorization = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        session.onAuthorizationResult(result.data)
    }
    private val presenter = AuthorizationPresenter { intent ->
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) false
        else { authorization.launch(intent); true }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[OrganisationEntryViewModel::class.java]
        session = SessionController.get(this)
        session.attachPresenter(presenter)
        // A fresh instance cannot receive the result of a browser step an earlier one opened (its task
        // was removed, say): that sign-in is cancelled rather than left waiting.
        session.onActivityCreated(fresh = savedInstanceState == null, carriesResult = carriesAuthorizationResult(intent))
        session.start()
        enableEdgeToEdge()
        setContent {
            DisposableEffect(model) { onDispose { model.deactivate(lifecycleToken) } }
            KoderaTheme {
                when (session.phase) {
                    SessionPhase.Restoring -> RestoringScreen()
                    is SessionPhase.SignedIn -> SignedInScreen(member = session.member, workspace = session.workspace,
                        onRetry = session::reloadMember, onCheckAgain = session::checkMemberAgain,
                        onWorkspaceRetry = session::retryWorkspace, onSignOut = session::signOut)
                    else -> OrganisationEntryScreen(state = model.state, onSlugChanged = model::updateSlug,
                        onLookup = model::lookup, onClear = model::clear, onCancel = model::cancelLookup,
                        onSelect = model::select,
                        signIn = SignInPanel(configured = session.signInConfigured, canSignIn = session.canSignIn,
                            signingIn = session.phase == SessionPhase.SigningIn,
                            developmentIssuer = session.developmentIssuer, notice = session.notice),
                        onSignIn = session::signIn, onCancelSignIn = session::cancelSignIn)
                }
            }
        }
    }
    override fun onStart() { super.onStart(); model.activate(lifecycleToken) }
    // Exactly one current /me→channels chain for each resumed entry; obsolete answers cannot publish.
    override fun onResume() { super.onResume(); session.onForeground() }
    override fun onPause() { session.onBackground(); super.onPause() }
    override fun onStop() { model.deactivate(lifecycleToken); super.onStop() }
    override fun onDestroy() { session.detachPresenter(presenter); super.onDestroy() }
}

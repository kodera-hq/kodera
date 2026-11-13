package io.kodera.android.session

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.kodera.android.DevelopmentBuild
import io.kodera.android.R
import io.kodera.android.auth.AppAuthBackend
import io.kodera.android.auth.AuthorizationPresenter
import io.kodera.android.auth.BrowserAuthorization
import io.kodera.android.auth.SessionStorage
import io.kodera.android.client.AcceptedOwner
import io.kodera.android.client.AccessTokenException
import io.kodera.android.client.CoreMeClient
import io.kodera.android.client.CoreRequester
import io.kodera.android.client.CoreWorkspaceClient
import io.kodera.android.client.WorkspaceFailure
import io.kodera.android.client.WorkspaceOutcome
import io.kodera.android.client.WorkspaceSnapshot
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.client.KoderaSignInService
import io.kodera.android.client.MeFailure
import io.kodera.android.client.MeOutcome
import io.kodera.android.client.Session
import io.kodera.android.client.SessionEndCause
import io.kodera.android.client.SessionEnded
import io.kodera.android.client.SignInException
import io.kodera.android.client.SignInFailure
import io.kodera.android.client.SignInService
import io.kodera.android.entry.Deployment
import io.kodera.android.entry.DeploymentConfiguration
import java.util.concurrent.Executor
import java.util.concurrent.Executors

sealed interface SessionPhase {
    data object Restoring : SessionPhase
    data object SignedOut : SessionPhase
    data object SigningIn : SessionPhase
    data class SignedIn(val session: Session) : SessionPhase
}

sealed interface MemberState {
    data object Loading : MemberState
    data class Loaded(val name: String, val organisation: String?) : MemberState
    data object CoreUnavailable : MemberState
    /**
     * Core answered 403. Core gives the same generic `forbidden` to an owner whose claim is not finished yet
     * and to anyone without an active membership, so the app cannot tell them apart and does not guess: one
     * state, which offers Check again and sign-out, and no link out of the app. Finishing a claim on the web changes Core's
     * answer, so `/me` is fetched again when the app returns to the foreground and on Check again
     * ([SessionController.checkMemberAgain]), never on its own.
     */
    data object NoOrganisationYet : MemberState

    companion object {
        /** What the screen shows when `/me` kept the session but named no member. */
        internal fun of(failure: MeFailure): MemberState = when (failure) {
            MeFailure.Forbidden -> NoOrganisationYet
            MeFailure.ProtocolViolation, MeFailure.ServiceUnavailable, MeFailure.IdentityUnavailable,
            is MeFailure.Transport -> CoreUnavailable
        }
    }
}

/** UI state holds only the current authorised snapshot, never a last-good cache. */
sealed interface WorkspaceViewState {
    /** Waiting for /me, not in the foreground, or no signed-in member: no second loading announcement. */
    data object Hidden : WorkspaceViewState
    data object Loading : WorkspaceViewState
    data class Loaded(val snapshot: WorkspaceSnapshot) : WorkspaceViewState
    data class Unavailable(@param:StringRes val message: Int) : WorkspaceViewState

    companion object {
        internal fun of(failure: WorkspaceFailure): WorkspaceViewState = Unavailable(when (failure) {
            WorkspaceFailure.Forbidden, WorkspaceFailure.NotFound -> R.string.workspace_unavailable
            WorkspaceFailure.ProtocolViolation -> R.string.workspace_invalid_response
            WorkspaceFailure.ServiceUnavailable, WorkspaceFailure.IdentityUnavailable -> R.string.workspace_service_unavailable
            is WorkspaceFailure.Transport -> R.string.workspace_connection_unavailable
        })
    }
}

/** Closed reader enums only: unknown wire states refuse the whole response before reaching the UI. */
@StringRes
internal fun workspaceRoomLabel(state: ChannelRoomState): Int = when (state) {
    ChannelRoomState.PENDING -> R.string.workspace_room_pending
    ChannelRoomState.READY -> R.string.workspace_room_ready
    ChannelRoomState.FAILED -> R.string.workspace_room_failed
}

/**
 * The process's one session owner: one AppAuth adapter, one [KoderaSignInService] (so one refresh
 * lock and one in-memory session per process), and what the interface shows of them. Activities come
 * and go and attach to it; it outlives them. Holds no token: those stay inside the sign-in service
 * and the sealed session file. State changes on the main thread only; the blocking sign-in, refresh
 * and Core calls run on worker threads and are fenced when they land late.
 *
 * Each signed-in session gets one [CoreRequester] (one OkHttp client and connection pool), shared by
 * every Core client of that session and closed once when the session ends or [close] runs.
 *
 * [get] builds the process's one; host tests build their own around a fake browser step, with [main]
 * a queue they drain on the test thread, and may answer `/me` themselves through [fetchMember].
 */
class SessionController internal constructor(
    private val deployment: Deployment,
    private val backend: BrowserAuthorization?,
    private val service: SignInService?,
    /** Runs a task on the main thread. */
    private val main: Executor,
    private val onMainThread: () -> Boolean,
    private val workers: Executor,
    /** Blocks, on a worker. Core's `/me` through the session's requester; a host test's script in tests. */
    private val fetchMember: (CoreMeClient) -> MeOutcome = CoreMeClient::fetch,
    /** Returns an already-decoded answer; tests can hold it across session/foreground transitions. */
    private val fetchWorkspace: (CoreWorkspaceClient, String) -> WorkspaceOutcome = CoreWorkspaceClient::fetch,
) : AutoCloseable {
    // Exact service-issued receipt returned by the accepted sign-in or restore.
    @Volatile private var generation: AcceptedOwner? = null
    private var readTicket = Any()
    private var targetOrganisation: String? = null
    private var loading = false
    private var resumed = false
    private var closed = false
    /** The signed-in session's Core clients; null when signed out or when Core is not configured. */
    private var core: CoreClients? = null
    private var started = false
    /** The sign-in in flight was cancelled because no Activity could receive its result, not by the member. */
    private var stranded = false

    var phase by mutableStateOf<SessionPhase>(SessionPhase.Restoring)
        private set
    var member by mutableStateOf<MemberState>(MemberState.Loading)
        private set
    var workspace by mutableStateOf<WorkspaceViewState>(WorkspaceViewState.Hidden)
        private set
    /** Why the last attempt did not end signed in, as a catalogue entry. */
    var notice by mutableStateOf<Int?>(null)
        private set

    val telecomCoordinator = TelecomPushCoordinator()
    val proximityV2Controller = ProximityV2CheckInController()
    val inviteCoordinator = ChannelInviteCoordinator()
    val passkeyCoordinator = PasskeySessionCoordinator()

    /** Whether this build can sign in at all; when false, entry says sign-in is not offered yet. */
    val signInConfigured: Boolean get() = service != null
    val canSignIn: Boolean get() = !closed && service != null && phase == SessionPhase.SignedOut
    val developmentIssuer: String? get() = deployment.developmentIssuer
    /** The validated Console origin this build names, or null. Held only: no screen opens it. */
    val consoleOrigin: String? get() = deployment.consoleOrigin

    init {
        // A session that ends anywhere (a refused refresh, Core refusing a fresh token, sign-out)
        // returns the interface to sign-in. A2 adds its own listener to purge what it derived.
        service?.addSessionEndedListener { event ->
            // The event already owns its receipt; listeners must never query/reenter the service here.
            val endedOwner = event.owner
            main.execute { if (!closed && endedOwner != null && generation === endedOwner) onSessionEnded(event) }
        }
    }

    /**
     * The "session ended" signal for features that keep data derived from the session (A2's Matrix
     * stores): told once per ended session, with which one and why, at the wipe, on the thread that
     * ended it and under the service's lock (see [SignInService.addSessionEndedListener]).
     */
    fun addSessionEndedListener(listener: (SessionEnded) -> Unit) { service?.addSessionEndedListener(listener) }

    private fun requireMain() = check(onMainThread())

    internal fun attachPresenter(presenter: AuthorizationPresenter) { backend?.attach(presenter) }
    internal fun detachPresenter(presenter: AuthorizationPresenter) { backend?.detach(presenter) }

    /**
     * The browser step's result. When no open browser step waits for it, the process was recreated
     * while the browser was open (or the sign-in was cancelled or timed out first): the request is
     * gone, so the member is told to start again rather than left with nothing. Not while a sign-in
     * is in flight, whose own outcome will speak, nor once signed in.
     */
    fun onAuthorizationResult(data: Intent?) {
        requireMain()
        val consumed = backend?.onAuthorizationResult(data) ?: false
        if (!consumed && (phase == SessionPhase.Restoring || phase == SessionPhase.SignedOut)) {
            notice = R.string.signin_interrupted
        }
    }

    /** The member's Cancel while signing in: ends the sign-in at whatever step it is, as "cancelled". */
    fun cancelSignIn() {
        requireMain()
        if (phase == SessionPhase.SigningIn) backend?.cancelAuthorization()
    }

    /**
     * An Activity was created. A fresh one ([fresh], not restored from saved state) that carries no
     * browser answer can never receive the result of a browser step an earlier instance opened, so
     * that sign-in is cancelled rather than left waiting.
     */
    internal fun onActivityCreated(fresh: Boolean, carriesResult: Boolean) {
        requireMain()
        if (fresh && !carriesResult && backend?.cancelAuthorization() == true) stranded = true
    }

    /**
     * Launch: the sealed session is read back without the network, so a cold start offline enters
     * the signed-in screen at once. The one silent forced refresh runs behind it; if the provider
     * refuses it, the session has been purged and the ended signal returns the interface to sign-in.
     */
    fun start() {
        requireMain()
        if (closed || started) return
        started = true
        val owner = service ?: run { phase = SessionPhase.SignedOut; return }
        workers.execute {
            val session = owner.restoreAccepted()
            main.execute {
                if (closed || phase != SessionPhase.Restoring) return@execute
                if (session == null) phase = SessionPhase.SignedOut
                else if (!enter(session, refreshFirst = true) && !closed && phase == SessionPhase.Restoring) leaveEndedSession()
            }
        }
    }

    fun signIn(issuer: String) {
        requireMain()
        val owner = service ?: return
        if (closed || phase != SessionPhase.SignedOut) return
        phase = SessionPhase.SigningIn
        notice = null
        stranded = false
        workers.execute {
            val outcome = try { Result.success(owner.signInAccepted(issuer)) } catch (error: SignInException) { Result.failure(error) }
            main.execute {
                if (closed || phase != SessionPhase.SigningIn) return@execute
                outcome.onSuccess {
                    if (!enter(it, refreshFirst = false) && !closed && phase == SessionPhase.SigningIn) leaveEndedSession()
                }.onFailure { error ->
                    val failure = (error as SignInException).failure
                    phase = SessionPhase.SignedOut
                    // The member did not cancel a sign-in no Activity could finish: it was interrupted.
                    notice = if (stranded && failure == SignInFailure.CANCELLED) R.string.signin_interrupted else noticeFor(failure)
                }
            }
        }
    }

    fun reloadMember() {
        requireMain()
        if (!closed && !loading && phase is SessionPhase.SignedIn) loadMember(refreshFirst = false)
    }

    /**
     * Explicit Check again from the no-organisation state. Foreground entry has its own single chain.
     * A current chain suppresses repeated taps, and no answer calls this, so it never loops.
     */
    fun checkMemberAgain() {
        requireMain()
        if (!closed && !loading && member == MemberState.NoOrganisationYet) loadMember(refreshFirst = false)
    }

    /** One fresh /me→channels chain per actual resumed entry, never a duplicate notification. */
    fun onForeground() {
        requireMain()
        if (closed || resumed) return
        resumed = true
        proximityV2Controller.onForeground()
        invalidateRead()
        if (phase is SessionPhase.SignedIn) loadMember(refreshFirst = false)
    }

    /** Obsolete physical calls may finish; their publication binding is already invalid. */
    fun onBackground() {
        requireMain()
        if (closed || !resumed) return
        resumed = false
        proximityV2Controller.onBackground()
        inviteCoordinator.dismissSheet(null)
        invalidateRead()
    }

    /** Retry revalidates membership first; no queued taps or automatic refusal loop. */
    fun retryWorkspace() {
        requireMain()
        if (!closed && resumed && !loading && phase is SessionPhase.SignedIn) loadMember(refreshFirst = false)
    }

    private fun invalidateRead() {
        readTicket = Any()
        targetOrganisation = null
        loading = false
        workspace = WorkspaceViewState.Hidden
    }

    fun signOut() {
        requireMain()
        if (closed || phase !is SessionPhase.SignedIn) return
        val owner = generation ?: return
        generation = null
        invalidateRead()
        endCore()
        phase = SessionPhase.SignedOut
        member = MemberState.Loading
        notice = null
        workers.execute { owner.signOut() }
    }

    /**
     * Decided on the cause, not on whether the service holds a session: a replaced session's signal
     * comes inside the sign-in that replaced it, when the service holds none. The service tells it at the
     * wipe, before any later session is held, and this queue keeps its order, so a signal that reaches a
     * signed-in phase is never a late one from a session that phase replaced.
     */
    private fun onSessionEnded(event: SessionEnded) {
        // The sign-in that replaced it speaks for itself: this controller signs in only from signed-out,
        // and that sign-in's own outcome sets the phase.
        if (event.cause == SessionEndCause.REPLACED) {
            generation = null
            invalidateRead()
            endCore()
            if (phase is SessionPhase.SignedIn) member = MemberState.CoreUnavailable
            return
        }
        // Signing out or in already: nothing shown to leave.
        if (phase !is SessionPhase.SignedIn) return
        leaveEndedSession()
    }

    private fun leaveEndedSession() {
        generation = null
        invalidateRead()
        endCore()
        phase = SessionPhase.SignedOut
        member = MemberState.Loading
        notice = R.string.session_ended
    }

    /** Reports actual owner adoption so a declined current pending entry can settle. Main thread only. */
    internal fun enter(accepted: AcceptedOwner, refreshFirst: Boolean): Boolean {
        requireMain()
        // Every way out of a session closes its requester (signOut, onSessionEnded, close). Closed here
        // too, so a path that enters without one of them can never leave a requester or pool open behind it.
        if (closed || accepted.isRetired) return false
        invalidateRead()
        generation = accepted
        endCore()
        core = coreClients(accepted)
        phase = SessionPhase.SignedIn(accepted.session)
        // Whatever the last attempt left (an interrupted step included) no longer applies.
        notice = null
        loadMember(refreshFirst)
        return true
    }

    private fun loadMember(refreshFirst: Boolean) {
        val signedIn = phase as? SessionPhase.SignedIn ?: return
        val ownerGeneration = generation ?: return
        invalidateRead()
        val ticket = readTicket
        val clients = core
        loading = true
        member = MemberState.Loading
        val owner = service
        workers.execute {
            // Launch's silent forced refresh. Unreachable keeps the session; refused has ended it.
            if (refreshFirst) try { ownerGeneration.refresh() } catch (_: AccessTokenException) { }
            val outcome = clients?.me?.let(fetchMember)
            main.execute {
                if (closed || ownerGeneration.isRetired || generation !== ownerGeneration || readTicket !== ticket || phase != signedIn ||
                    core !== clients || clients?.requester?.isClosed == true) return@execute
                loading = false
                when (outcome) {
                    null -> member = MemberState.CoreUnavailable
                    is MeOutcome.Member -> {
                        val organisation = outcome.profile.organisations.singleOrNull { it.realm == signedIn.session.realm }
                        configureSessionCoordinators(organisation?.id)
                        member = MemberState.Loaded(outcome.profile.displayName ?: outcome.profile.email, organisation?.name)
                        if (resumed) {
                            if (organisation == null) workspace = WorkspaceViewState.Unavailable(R.string.workspace_unavailable)
                            else {
                                targetOrganisation = organisation.id
                                loadWorkspace(PublicationBinding(ownerGeneration, ticket, organisation.id, clients.requester), clients.workspace)
                            }
                        }
                    }
                    MeOutcome.SignedOut -> {
                        if (owner?.isSignedIn == true) member = MemberState.CoreUnavailable else leaveEndedSession()
                    }
                    is MeOutcome.Unavailable -> {
                        if (outcome.failure == MeFailure.Forbidden) configureSessionCoordinators(null)
                        member = MemberState.of(outcome.failure)
                    }
                }
            }
        }
    }

    private data class PublicationBinding(val generation: AcceptedOwner, val ticket: Any, val organisation: String,
        val requester: CoreRequester)

    private fun loadWorkspace(binding: PublicationBinding, client: CoreWorkspaceClient) {
        loading = true
        workspace = WorkspaceViewState.Loading
        workers.execute {
            val outcome = fetchWorkspace(client, binding.organisation)
            main.execute { workspaceAnswered(binding, outcome) }
        }
    }

    /** Complete controller publication fence; the held-answer calibration targets this whole predicate. */
    private fun isCurrentPublication(binding: PublicationBinding): Boolean =
        !closed && resumed && phase is SessionPhase.SignedIn && !binding.generation.isRetired && generation === binding.generation &&
            readTicket === binding.ticket && targetOrganisation == binding.organisation &&
            core?.requester === binding.requester && !binding.requester.isClosed

    private fun workspaceAnswered(binding: PublicationBinding, outcome: WorkspaceOutcome) {
        if (!isCurrentPublication(binding)) return
        loading = false
        workspace = when (outcome) {
            is WorkspaceOutcome.Loaded -> if (outcome.workspace.organisationId == binding.organisation)
                WorkspaceViewState.Loaded(outcome.workspace)
                else WorkspaceViewState.Unavailable(R.string.workspace_invalid_response)
            is WorkspaceOutcome.Unavailable -> WorkspaceViewState.of(outcome.failure)
            WorkspaceOutcome.SignedOut -> {
                if (service?.isSignedIn == true) WorkspaceViewState.Unavailable(R.string.workspace_service_unavailable)
                else { leaveEndedSession(); WorkspaceViewState.Hidden }
            }
        }
    }

    /**
     * The session's one requester, handed to every Core client of the session (A2 adds its own here).
     * Null when Core is not configured or its origin is refused.
     */
    private fun coreClients(owner: AcceptedOwner): CoreClients? {
        val origin = deployment.coreApiOrigin ?: return null
        val requester = try { CoreRequester(origin, DevelopmentBuild.loopback, owner) }
            catch (_: IllegalArgumentException) { return null }
        return CoreClients(requester, CoreMeClient(requester), CoreWorkspaceClient(requester))
    }

    private fun configureSessionCoordinators(organisationId: String?) {
        runCatching { telecomCoordinator.configureOrganisation(organisationId) }
        runCatching { proximityV2Controller.configureOrganisation(organisationId) }
        inviteCoordinator.configureOrganisation(organisationId)
        passkeyCoordinator.configureOrganisation(organisationId)
    }

    /** Closes the ended session's requester, once: a request still in flight finishes and is fenced. */
    private fun endCore() {
        configureSessionCoordinators(null)
        core?.requester?.close()
        core = null
    }

    /** The current session's requester, for host tests. */
    internal val coreRequester: CoreRequester? get() = core?.requester

    /** Shuts the controller's Core clients down; the process's own controller never needs it. */
    override fun close() {
        requireMain()
        if (closed) return
        closed = true
        generation = null
        invalidateRead()
        endCore()
        telecomCoordinator.stop()
        proximityV2Controller.close()
        inviteCoordinator.stop()
        passkeyCoordinator.clear()
    }

    private class CoreClients(val requester: CoreRequester, val me: CoreMeClient, val workspace: CoreWorkspaceClient)

    /** IN_PROGRESS has no notice: another sign-in is already open, and its own outcome will speak. */
    @StringRes
    private fun noticeFor(failure: SignInFailure): Int? = when (failure) {
        SignInFailure.CANCELLED -> R.string.signin_cancelled
        SignInFailure.IN_PROGRESS -> null
        SignInFailure.UNTRUSTED_ISSUER -> R.string.signin_untrusted
        SignInFailure.IDENTITY_UNAVAILABLE -> R.string.signin_unavailable
        SignInFailure.REFUSED -> R.string.signin_refused
        SignInFailure.STORAGE -> R.string.signin_storage
        SignInFailure.NOT_CONFIGURED -> R.string.login_unavailable
    }

    companion object {
        @Volatile private var instance: SessionController? = null

        /** The process's one controller, created on first use from the application context. */
        fun get(context: Context): SessionController = instance ?: synchronized(this) {
            instance ?: create(context.applicationContext).also { instance = it }
        }

        private fun create(context: Context): SessionController {
            val deployment = DeploymentConfiguration.read()
            val backend = deployment.signIn?.let { AppAuthBackend(context, DevelopmentBuild.loopback) }
            val service = deployment.signIn?.let { configuration ->
                backend?.let { KoderaSignInService(configuration, SessionStorage.store(context), it) }
            }
            val handler = Handler(Looper.getMainLooper())
            // Process-wide and never shut down; idle threads time out.
            val workers = Executors.newCachedThreadPool { task -> Thread(task, "kodera-session").apply { isDaemon = true } }
            return SessionController(deployment, backend, service, Executor { task -> handler.post(task) },
                { Looper.myLooper() == Looper.getMainLooper() }, workers)
        }
    }
}

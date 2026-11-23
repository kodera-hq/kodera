package io.kodera.android.session

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Build
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
import io.kodera.android.calls.NativeTelecomRuntime
import io.kodera.android.client.NativeCallCoordinator
import io.kodera.android.client.NativeCallResolver
import io.kodera.android.client.LiveKitWebRTCSession
import io.kodera.android.domain.ChannelKind
import io.kodera.android.client.AcceptedOwner
import io.kodera.android.client.AccessTokenException
import io.kodera.android.client.ChannelConversationTransport
import io.kodera.android.client.CoreMeClient
import io.kodera.android.client.CoreRequester
import io.kodera.android.client.CoreWorkspaceClient
import io.kodera.android.client.CoreProximityClient
import io.kodera.android.client.KoderaSignInService
import io.kodera.android.client.MatrixChannelConversationTransport
import io.kodera.android.client.MatrixClientError
import io.kodera.android.client.MatrixClientException
import io.kodera.android.client.MatrixHttpStub
import io.kodera.android.client.MatrixRoomClient
import io.kodera.android.client.MatrixSsoAuthorizer
import io.kodera.android.client.MeFailure
import io.kodera.android.client.MeOutcome
import io.kodera.android.client.MemberOrganisation
import io.kodera.android.client.MemberProfile
import io.kodera.android.client.PersistedMatrixSession
import io.kodera.android.client.ProximityBootstrap
import io.kodera.android.client.PushWakeupCoordinator
import io.kodera.android.client.RustSessionVault
import io.kodera.android.client.Session
import io.kodera.android.client.SessionEndCause
import io.kodera.android.client.SessionEnded
import io.kodera.android.client.SessionFence
import io.kodera.android.client.SignInException
import io.kodera.android.client.SignInFailure
import io.kodera.android.client.SignInService
import io.kodera.android.client.TokenStoreException
import io.kodera.android.client.WorkspaceChannel
import io.kodera.android.client.WorkspaceChannelLifecycle
import io.kodera.android.client.WorkspaceFailure
import io.kodera.android.client.WorkspaceOutcome
import io.kodera.android.client.WorkspaceSnapshot
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.UuidV7Identifier
import io.kodera.android.domain.ZeroPayloadWakeupEnvelope
import io.kodera.android.entry.Deployment
import io.kodera.android.entry.DeploymentConfiguration
import io.kodera.android.proximity.AndroidBleGattProximityDriver
import io.kodera.android.proximity.AndroidNsdMdnsProximityDriver
import io.kodera.android.proximity.RuntimeProximityPermissionChecker
import io.kodera.android.proximity.VoluntaryProximitySessionController
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.security.SecureRandom
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
    val voluntaryProximityController: VoluntaryProximitySessionController? = null,
    private val fetchProximity: (CoreProximityClient, String) -> ProximityBootstrap? = CoreProximityClient::bootstrap,
    private val clockUnixSeconds: () -> Long = { System.currentTimeMillis() / 1_000L },
    private val rustSessionVault: RustSessionVault? = null,
    private val sessionStateDir: File? = null,
    private val registerPush: (PushWakeupCoordinator, String, String, String, String) -> Unit =
        { client, deviceId, endpoint, p256dh, auth -> client.registerDeviceWakeup(deviceId, endpoint, p256dh, auth) },
    private val revokePush: (PushWakeupCoordinator, String) -> Unit = PushWakeupCoordinator::revokeOnSignOut,
    private val matrixSsoAuthorizer: MatrixSsoAuthorizer? = null,
    private val matrixHttpStub: MatrixHttpStub? = null,
    private val conversationTransportFactory: ((
        ChannelConversationScope,
        CoreRequester?,
        AcceptedOwner?,
        MemberOrganisation?,
        String?,
        SessionFence,
    ) -> ChannelConversationTransport?)? = null,
) : AutoCloseable {
    // Exact service-issued receipt returned by the accepted sign-in or restore.
    @Volatile private var generation: AcceptedOwner? = null
    @Volatile private var activeSessionFence = SessionFence()
    private val vaultStateLock = Any()
    @Volatile private var vaultNotWiped = false
    private var inMemoryVaultDeviceId: String? = null
    @Volatile private var registeredPushDeviceId: String? = null
    private var activeMemberProfile: MemberProfile? = null
    private var activeMemberOrganisation: MemberOrganisation? = null
    private var activeVaultOrganisationId: String? = null
    var nativeCalls: NativeTelecomRuntime? = null
        private set
    private var activeMatrixTransport: MatrixChannelConversationTransport? = null
    @Volatile private var activeMatrixSession: PersistedMatrixSession? = null
    private val _isForeground = MutableStateFlow(false)
    val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()
    private var readTicket = Any()
    private var targetOrganisation: String? = null
    private var loading = false
    private var proximityPermissionPause: Any? = null
    private var proximityScope: Pair<String, String>? = null
    private var resumed = false
    private var closed = false
    /** The signed-in session's Core clients; null when signed out or when Core is not configured. */
    private var core: CoreClients? = null
    private var started = false
    /** The sign-in in flight was cancelled because no Activity could receive its result, not by the member. */
    private var stranded = false
    private var proximityTicket = Any()
    var proximityPreparing by mutableStateOf(false)
        private set
    var proximityMessage by mutableStateOf<Int?>(null)
        private set

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
    var activeConversation by mutableStateOf<ChannelConversationController?>(null)
        private set

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
        voluntaryProximityController?.onAuthenticatedRebootstrapRequired = { deadline ->
            main.execute { rebootstrapProximityUntil(deadline) }
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
        if (phase == SessionPhase.SignedOut && notice == R.string.session_not_wiped) {
            phase = SessionPhase.Restoring
        }
        val owner = service ?: run {
            if (vaultNotWiped || unwipedMarkerExists()) {
                workers.execute {
                    val wiped = wipeVaultBlocking(clearPushDeviceId = true)
                    main.execute {
                        if (!closed) {
                            if (!wiped) started = false
                            phase = SessionPhase.SignedOut
                            notice = if (wiped) null else R.string.session_not_wiped
                        }
                    }
                }
            } else {
                phase = SessionPhase.SignedOut
            }
            return
        }
        workers.execute {
            if (vaultNotWiped || unwipedMarkerExists()) {
                val wiped = wipeVaultBlocking(clearPushDeviceId = true)
                if (wiped) {
                    runCatching { owner.signOut() }
                }
                main.execute {
                    if (closed || phase != SessionPhase.Restoring) return@execute
                    if (!wiped) started = false
                    phase = SessionPhase.SignedOut
                    notice = if (wiped) null else R.string.session_not_wiped
                }
                return@execute
            }
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
            if (!ensurePreviousSessionWipedOnWorker()) {
                main.execute {
                    if (closed || phase != SessionPhase.SigningIn) return@execute
                    phase = SessionPhase.SignedOut
                    notice = R.string.session_not_wiped
                }
                return@execute
            }
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
        _isForeground.value = true
        activeConversation?.onForegroundChanged(true)
        voluntaryProximityController?.onForegroundChanged(true)
        proximityV2Controller.onForeground()
        invalidateRead()
        if (phase is SessionPhase.SignedIn) loadMember(refreshFirst = false)
    }

    /** Obsolete physical calls may finish; their publication binding is already invalid. */
    fun onBackground() {
        requireMain()
        if (closed || (!resumed && proximityPermissionPause == null)) return
        proximityPermissionPause = null
        resumed = false
        _isForeground.value = false
        activeConversation?.onForegroundChanged(false)
        voluntaryProximityController?.onForegroundChanged(false)
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
        proximityPermissionPause = null
        proximityScope = null
        proximityTicket = Any()
        proximityPreparing = false
        proximityMessage = null
        voluntaryProximityController?.clearProvisioning()
        readTicket = Any()
        targetOrganisation = null
        loading = false
        workspace = WorkspaceViewState.Hidden
    }

    fun signOut() {
        requireMain()
        if (closed || phase !is SessionPhase.SignedIn) return
        val owner = generation ?: return
        val pushDeviceId = registeredPushDeviceId ?: readPersistedPushDeviceId()
        val matrixToLogout = activeMatrixTransport
        val retainedMatrixSession = activeMatrixSession
        val vaultOrgAtSignOut = activeVaultOrganisationId ?: activeMemberOrganisation?.id ?: targetOrganisation
        activeMatrixTransport = null
        activeMatrixSession = null
        registeredPushDeviceId = null
        activeMemberProfile = null
        activeMemberOrganisation = null
        activeVaultOrganisationId = null
        generation = null
        val retiringFence = rotateSessionFence()
        invalidateRead()
        endCore()
        phase = SessionPhase.SignedOut
        member = MemberState.Loading
        notice = null
        val coreOrigin = deployment.coreApiOrigin
        workers.execute {
            if (pushDeviceId != null && coreOrigin != null) {
                val tempRequester = try {
                    CoreRequester(coreOrigin, DevelopmentBuild.loopback, owner)
                } catch (_: IllegalArgumentException) {
                    null
                }
                tempRequester?.use { requester ->
                    runCatching { revokePush(PushWakeupCoordinator(requester), pushDeviceId) }
                }
            }
            val sessionFromVault = retainedMatrixSession ?: readPersistedMatrixSessionForLogout(vaultOrgAtSignOut)
            val loggedOutViaTransport = runCatching { matrixToLogout?.logoutIfAuthenticated() ?: false }.getOrDefault(false)
            runCatching { matrixToLogout?.close() }
            if (!loggedOutViaTransport && sessionFromVault != null) {
                runCatching {
                    MatrixRoomClient.logoutStandalone(
                        homeserverOrigin = sessionFromVault.homeserverOrigin,
                        matrixAccessToken = sessionFromVault.accessToken,
                        loopback = DevelopmentBuild.loopback,
                        httpStub = matrixHttpStub,
                    )
                }
            }
            val wiped = wipeVaultBlocking(clearPushDeviceId = true, retiringFence = retiringFence)
            if (!wiped) {
                main.execute {
                    if (!closed && phase == SessionPhase.SignedOut) {
                        notice = R.string.session_not_wiped
                    }
                }
            }
            owner.signOut()
        }
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
            val matrixToClose = activeMatrixTransport
            activeMatrixTransport = null
            activeMatrixSession = null
            registeredPushDeviceId = null
            activeMemberProfile = null
            activeMemberOrganisation = null
            activeVaultOrganisationId = null
            generation = null
            val retiringFence = rotateSessionFence()
            invalidateRead()
            endCore()
            if (phase is SessionPhase.SignedIn) member = MemberState.CoreUnavailable
            if (matrixToClose != null || rustSessionVault != null || sessionStateDir != null) {
                workers.execute {
                    runCatching { matrixToClose?.close() }
                    if (!wipeVaultBlocking(clearPushDeviceId = true, retiringFence = retiringFence)) {
                        main.execute {
                            if (!closed) notice = R.string.session_not_wiped
                        }
                    }
                }
            }
            return
        }
        // Signing out or in already: nothing shown to leave.
        if (phase !is SessionPhase.SignedIn) return
        leaveEndedSession()
    }

    private fun leaveEndedSession() {
        val matrixToClose = activeMatrixTransport
        activeMatrixTransport = null
        activeMatrixSession = null
        registeredPushDeviceId = null
        activeMemberProfile = null
        activeMemberOrganisation = null
        activeVaultOrganisationId = null
        generation = null
        val retiringFence = rotateSessionFence()
        invalidateRead()
        endCore()
        phase = SessionPhase.SignedOut
        member = MemberState.Loading
        notice = R.string.session_ended
        if (matrixToClose != null || rustSessionVault != null || sessionStateDir != null) {
            workers.execute {
                runCatching { matrixToClose?.close() }
                if (!wipeVaultBlocking(clearPushDeviceId = true, retiringFence = retiringFence)) {
                    main.execute {
                        if (!closed && phase == SessionPhase.SignedOut) {
                            notice = R.string.session_not_wiped
                        }
                    }
                }
            }
        }
    }

    /** Reports actual owner adoption so a declined current pending entry can settle. Main thread only. */
    internal fun enter(accepted: AcceptedOwner, refreshFirst: Boolean): Boolean {
        requireMain()
        // Every way out of a session closes its requester (signOut, onSessionEnded, close). Closed here
        // too, so a path that enters without one of them can never leave a requester or pool open behind it.
        if (closed || accepted.isRetired) return false
        rotateSessionFence()
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
                        activeMemberProfile = outcome.profile
                        activeMemberOrganisation = organisation
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
                        if (outcome.failure == MeFailure.Forbidden) {
                            activeMemberOrganisation = null
                            configureSessionCoordinators(null)
                        }
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
    private fun isCurrentPublication(binding: PublicationBinding): Boolean = resumed && isCurrentOwnerScope(binding)

    private fun isCurrentOwnerScope(binding: PublicationBinding): Boolean =
        !closed && phase is SessionPhase.SignedIn && !binding.generation.isRetired && generation === binding.generation &&
            readTicket === binding.ticket && targetOrganisation == binding.organisation &&
            core?.requester === binding.requester && !binding.requester.isClosed

    internal class ProximityConsentRequest(
        val permissions: Array<String>,
        val pauseForDialog: () -> Boolean,
        val resumeAfterDialog: () -> Boolean,
        val cancel: () -> Unit,
        val complete: () -> Unit,
    )

    /** Created only by an explicit consent gesture; permission answers retain this exact owner/scope. */
    internal fun proximityConsentRequest(): ProximityConsentRequest? {
        requireMain()
        val radio = voluntaryProximityController ?: return null
        val snapshot = (workspace as? WorkspaceViewState.Loaded)?.snapshot ?: return null
        val workspaceId = snapshot.id ?: return null
        val owner = generation ?: return null
        val clients = core ?: return null
        val organisation = targetOrganisation ?: return null
        val binding = PublicationBinding(owner, readTicket, organisation, clients.requester)
        if (!isCurrentPublication(binding) || snapshot.organisationId != organisation || proximityPreparing) return null
        val ticket = Any()
        proximityTicket = ticket
        var answered = false
        return ProximityConsentRequest(
            permissions = radio.refreshPermissionState().toTypedArray(),
            pauseForDialog = {
                requireMain()
                val current = !answered && proximityTicket === ticket && isCurrentPublication(binding) &&
                    (workspace as? WorkspaceViewState.Loaded)?.snapshot?.id == workspaceId
                if (current) {
                    // The system permission dialog is visible; no radio capability survives focus loss.
                    proximityPermissionPause = ticket
                    resumed = false
                    _isForeground.value = false
                    activeConversation?.onForegroundChanged(false)
                    radio.onForegroundChanged(false)
                    radio.clearProvisioning()
                    proximityV2Controller.onBackground()
                    inviteCoordinator.dismissSheet(null)
                }
                current
            },
            resumeAfterDialog = {
                requireMain()
                val current = !answered && proximityPermissionPause === ticket && proximityTicket === ticket &&
                    isCurrentOwnerScope(binding) && (workspace as? WorkspaceViewState.Loaded)?.snapshot?.id == workspaceId
                if (current) {
                    proximityPermissionPause = null
                    resumed = true
                    _isForeground.value = true
                    activeConversation?.onForegroundChanged(true)
                    radio.onForegroundChanged(true)
                    proximityV2Controller.onForeground()
                }
                current
            },
            cancel = {
                requireMain()
                if (proximityPermissionPause === ticket) invalidateRead()
                else if (proximityTicket === ticket) {
                    proximityTicket = Any()
                    proximityPreparing = false
                    radio.clearProvisioning()
                }
            },
            complete = complete@{
                requireMain()
                if (answered) return@complete
                answered = true
                if (proximityTicket === ticket && isCurrentPublication(binding) &&
                    (workspace as? WorkspaceViewState.Loaded)?.snapshot?.id == workspaceId) {
                    if (radio.refreshPermissionState().isNotEmpty()) {
                        proximityMessage = R.string.proximity_voluntary_permissions_missing
                    } else {
                        proximityPreparing = true
                        proximityMessage = null
                        workers.execute {
                            val material = runCatching { fetchProximity(clients.proximity, workspaceId) }.getOrNull()
                            main.execute publish@{
                                try {
                                    if (proximityTicket !== ticket || !isCurrentPublication(binding) ||
                                        (workspace as? WorkspaceViewState.Loaded)?.snapshot?.id != workspaceId) return@publish
                                    proximityPreparing = false
                                    if (material == null || material.workspaceId != workspaceId || radio.refreshPermissionState().isNotEmpty()) {
                                        proximityMessage = R.string.proximity_voluntary_bootstrap_unavailable
                                    } else {
                                        val seed = ByteArray(32).also(SecureRandom()::nextBytes)
                                        try {
                                            radio.provisionEpoch(workspaceId, material.scopeTag, material.epoch,
                                                material.epochExpiresAtUnixSeconds, material.epochMacKey, seed,
                                                nowUnixSeconds = clockUnixSeconds())
                                            radio.grantForegroundConsent()
                                            proximityScope = organisation to workspaceId
                                        } catch (_: Exception) {
                                            proximityScope = null
                                            radio.clearProvisioning()
                                            proximityMessage = R.string.proximity_voluntary_bootstrap_unavailable
                                        } finally { seed.fill(0) }
                                    }
                                } finally { material?.epochMacKey?.fill(0) }
                            }
                        }
                    }
                }
            },
        )
    }

    /**
     * Renews an active voluntary proximity session across the 15-minute epoch-lease boundary up to
     * the member's original consent deadline (`deadlineUnixSeconds`), without extending consent or
     * surviving backgrounding, workspace changes, or sign-out.
     */
    private fun rebootstrapProximityUntil(deadlineUnixSeconds: Long) {
        if (closed || !resumed || proximityPreparing) return
        val nowAtRequest = clockUnixSeconds()
        if (deadlineUnixSeconds <= nowAtRequest) return
        val radio = voluntaryProximityController ?: return
        val snapshot = (workspace as? WorkspaceViewState.Loaded)?.snapshot ?: return
        val workspaceId = snapshot.id ?: return
        val owner = generation ?: return
        val clients = core ?: return
        val organisation = targetOrganisation ?: return
        val binding = PublicationBinding(owner, readTicket, organisation, clients.requester)
        if (!isCurrentPublication(binding) || snapshot.organisationId != organisation) return
        if (proximityScope != (organisation to workspaceId)) return
        if (radio.refreshPermissionState().isNotEmpty()) {
            proximityScope = null
            proximityMessage = R.string.proximity_voluntary_permissions_missing
            return
        }

        val ticket = Any()
        proximityTicket = ticket
        proximityPreparing = true
        proximityMessage = null
        workers.execute {
            val material = runCatching { fetchProximity(clients.proximity, workspaceId) }.getOrNull()
            main.execute publish@{
                try {
                    if (proximityTicket !== ticket || !isCurrentPublication(binding) ||
                        (workspace as? WorkspaceViewState.Loaded)?.snapshot?.id != workspaceId ||
                        proximityScope != (organisation to workspaceId)
                    ) {
                        return@publish
                    }
                    proximityPreparing = false
                    val now = clockUnixSeconds()
                    if (now >= deadlineUnixSeconds || material == null || material.workspaceId != workspaceId ||
                        radio.refreshPermissionState().isNotEmpty()
                    ) {
                        proximityScope = null
                        radio.clearProvisioning()
                        proximityMessage = R.string.proximity_voluntary_bootstrap_unavailable
                    } else {
                        val seed = ByteArray(32).also(SecureRandom()::nextBytes)
                        try {
                            radio.provisionEpoch(
                                workspaceId,
                                material.scopeTag,
                                material.epoch,
                                material.epochExpiresAtUnixSeconds,
                                material.epochMacKey,
                                seed,
                                nowUnixSeconds = now,
                            )
                            radio.grantForegroundConsent()
                            radio.startVoluntarySession(
                                nowUnixSeconds = now,
                                consentExpiresAtUnixSeconds = deadlineUnixSeconds,
                            )
                        } catch (_: Exception) {
                            proximityScope = null
                            radio.clearProvisioning()
                            proximityMessage = R.string.proximity_voluntary_bootstrap_unavailable
                        } finally {
                            seed.fill(0)
                        }
                    }
                } finally {
                    material?.epochMacKey?.fill(0)
                }
            }
        }
    }

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
        if (outcome is WorkspaceOutcome.Loaded) {
            activeConversation?.let { conversation ->
                val channels = outcome.workspace.uncategorisedChannels + outcome.workspace.categories.flatMap { it.channels }
                val channel = channels.firstOrNull { it.id == conversation.scope.channelId }
                if (outcome.workspace.organisationId != conversation.scope.organisationId || channel == null || channel.lifecycle != WorkspaceChannelLifecycle.ACTIVE) closeChannel()
                else conversation.updateChannelSecurity(channel.isConfidential)
            }
        } else if (
            outcome is WorkspaceOutcome.Unavailable &&
            (outcome.failure == WorkspaceFailure.Forbidden || outcome.failure == WorkspaceFailure.NotFound)
        ) {
            closeChannel()
        }
    }

    /**
     * The session's one requester, handed to every Core client of the session (A2 adds its own here).
     * Null when Core is not configured or its origin is refused.
     */
    fun openChannel(channel: WorkspaceChannel, organisationId: String) {
        requireMain()
        if (closed || phase !is SessionPhase.SignedIn || member !is MemberState.Loaded) return
        val snapshot = (workspace as? WorkspaceViewState.Loaded)?.snapshot ?: return
        if (snapshot.organisationId != organisationId) return
        val scope = ChannelConversationScope.fromChannel(organisationId, channel) ?: return
        closeChannel()
        val conversationFence = SessionFence()
        activeSessionFence.registerCancellation { conversationFence.invalidate() }
        val ownerSubject = generation?.authenticatedSubject()
        val transport = if (conversationTransportFactory != null) {
            conversationTransportFactory.invoke(
                scope,
                core?.requester,
                generation,
                activeMemberOrganisation,
                ownerSubject,
                conversationFence,
            )
        } else {
            buildProductionConversationTransport(scope, conversationFence)
        }
        val ownId = transport?.ownUserId
            ?: ownerSubject?.let { sub ->
                val slug = activeMemberOrganisation?.slug?.lowercase()
                val domain = deployment.coreApiOrigin?.let { MatrixRoomClient.deriveMatrixDomain(it, DevelopmentBuild.loopback) }
                if (slug != null && domain != null) "@$sub:$slug.$domain" else "@me:kodera.local"
            }
            ?: "@me:kodera.local"
        activeConversation = ChannelConversationController(
            scope = scope,
            transport = transport,
            ownUserId = ownId,
            mainExecutor = main,
            workerExecutor = workers,
            fence = conversationFence,
            initialForeground = _isForeground.value,
        )
    }

    /** Provisioned call adapters share the selected audio channel's authenticated transport. */
    fun provisionNativeCalls(context: Context, localPartyId: String, resolver: NativeCallResolver, media: LiveKitWebRTCSession) {
        requireMain()
        check(phase is SessionPhase.SignedIn && member is MemberState.Loaded)
        val scope = activeConversation?.scope ?: error("channel unavailable")
        check(scope.kind == ChannelKind.AUDIO)
        val transport = activeMatrixTransport ?: error("transport unavailable")
        nativeCalls?.stop(); nativeCalls = null
        val coordinator = NativeCallCoordinator(scope.organisationId, localPartyId, resolver, media, transport, clockUnixSeconds)
        val runtime = NativeTelecomRuntime(context.applicationContext, coordinator)
        runtime.start(); nativeCalls = runtime
    }

    fun closeChannel() {
        requireMain()
        nativeCalls?.stop(); nativeCalls = null
        activeConversation?.clear()
        activeConversation = null
        val matrixToClose = activeMatrixTransport
        activeMatrixTransport = null
        if (matrixToClose != null) {
            workers.execute { runCatching { matrixToClose.close() } }
        }
    }

    /** Registers a payload-free wakeup endpoint (`endpoint`, `p256dh`, `auth`) on Core for the active session. */
    fun registerPushWakeup(
        deviceId: String,
        endpoint: String,
        p256dh: String,
        auth: String,
        onComplete: ((Boolean) -> Unit)? = null,
    ) {
        requireMain()
        if (closed || phase !is SessionPhase.SignedIn) {
            onComplete?.invoke(false)
            return
        }
        val owner = generation ?: run { onComplete?.invoke(false); return }
        val clients = core ?: run { onComplete?.invoke(false); return }
        val fenceSnapshot = activeSessionFence
        workers.execute {
            if (fenceSnapshot.isInvalidated || owner.isRetired) {
                main.execute { onComplete?.invoke(false) }
                return@execute
            }
            val succeeded = runCatching {
                registerPush(clients.pushWakeup, deviceId, endpoint, p256dh, auth)
            }.isSuccess
            if (succeeded && !fenceSnapshot.isInvalidated && !owner.isRetired) {
                persistPushDeviceId(deviceId)
                registeredPushDeviceId = deviceId
            }
            main.execute { onComplete?.invoke(succeeded) }
        }
    }

    /** Admits a zero-payload wakeup envelope (`kodera-rs` schema) and triggers a fenced sync if a conversation is open. */
    fun handleIncomingPushWakeup(rawPayload: ByteArray): Boolean {
        requireMain()
        if (closed || phase !is SessionPhase.SignedIn) return false
        val orgId = activeMemberOrganisation?.id ?: targetOrganisation ?: return false
        val envelope = runCatching { ZeroPayloadWakeupEnvelope.admit(rawPayload) }.getOrNull() ?: return false
        if (envelope.organisationId != orgId) return false
        activeConversation?.refreshSync()
        return true
    }

    private fun buildProductionConversationTransport(
        scope: ChannelConversationScope,
        conversationFence: SessionFence,
    ): ChannelConversationTransport? {
        val clients = core ?: return null
        val requester = clients.requester
        val owner = generation ?: return null
        val coreOrigin = deployment.coreApiOrigin ?: return null
        val org = activeMemberOrganisation?.takeIf { it.id == scope.organisationId } ?: return null
        val matrixDomain = MatrixRoomClient.deriveMatrixDomain(coreOrigin, DevelopmentBuild.loopback) ?: return null
        val vaultDeviceId = loadOrCreateVaultDeviceId()
        val vault = rustSessionVault
        val roomClient = MatrixRoomClient(
            coreRequester = requester,
            loopback = DevelopmentBuild.loopback,
            fence = conversationFence,
            httpStub = matrixHttpStub,
        )
        val ssoAuthorizer = matrixSsoAuthorizer ?: MatrixSsoAuthorizer { request ->
            backend?.authorizeMatrixSso(request)
                ?: throw MatrixClientException(MatrixClientError.IDENTITY_UNAVAILABLE)
        }
        val transport = MatrixChannelConversationTransport(
            roomClient = roomClient,
            fetchWorkspace = { orgId -> this.fetchWorkspace(clients.workspace, orgId) },
            organisationId = scope.organisationId,
            organisationSlug = org.slug,
            matrixDomain = matrixDomain,
            vaultDeviceId = vaultDeviceId,
            owner = owner,
            ssoAuthorizer = ssoAuthorizer,
            loadVault = { orgId, devId ->
                if (conversationFence.isInvalidated || owner.isRetired) null
                else vault?.open(orgId, devId)
            },
            saveVault = { orgId, devId, bytes ->
                if (vault != null) {
                    vault.sealIfActive(orgId, devId, bytes) {
                        !conversationFence.isInvalidated && !owner.isRetired
                    } != null
                } else {
                    !conversationFence.isInvalidated && !owner.isRetired
                }
            },
            onSessionEstablished = { established ->
                if (!conversationFence.isInvalidated && !owner.isRetired) {
                    activeMatrixSession = established
                }
            },
        )
        activeMatrixTransport = transport
        return transport
    }

    private fun coreClients(owner: AcceptedOwner): CoreClients? {
        val origin = deployment.coreApiOrigin ?: return null
        val requester = try { CoreRequester(origin, DevelopmentBuild.loopback, owner) }
            catch (_: IllegalArgumentException) { return null }
        return CoreClients(
            requester,
            CoreMeClient(requester),
            CoreWorkspaceClient(requester),
            CoreProximityClient(requester),
            PushWakeupCoordinator(requester),
        )
    }

    private fun configureSessionCoordinators(organisationId: String?) {
        val currentOpenOrg = activeConversation?.scope?.organisationId
        if (currentOpenOrg != null && currentOpenOrg != organisationId) {
            closeChannel()
        }
        val previousVaultOrg = activeVaultOrganisationId
        if (organisationId != null && previousVaultOrg != null && previousVaultOrg != organisationId) {
            val retiringFence = rotateSessionFence()
            closeChannel()
            activeMatrixSession = null
            activeVaultOrganisationId = organisationId
            if (rustSessionVault != null || sessionStateDir != null) {
                workers.execute {
                    if (!wipeVaultBlocking(clearPushDeviceId = false, retiringFence = retiringFence)) {
                        main.execute {
                            if (!closed) {
                                if (phase is SessionPhase.SignedIn) {
                                    val owner = generation
                                    generation = null
                                    invalidateRead()
                                    endCore()
                                    phase = SessionPhase.SignedOut
                                    member = MemberState.Loading
                                    if (owner != null) workers.execute { owner.signOut() }
                                }
                                notice = R.string.session_not_wiped
                            }
                        }
                    }
                }
            }
        } else if (organisationId != null) {
            activeVaultOrganisationId = organisationId
        }
        runCatching { telecomCoordinator.configureOrganisation(organisationId) }
        runCatching { proximityV2Controller.configureOrganisation(organisationId) }
        inviteCoordinator.configureOrganisation(organisationId)
        passkeyCoordinator.configureOrganisation(organisationId)
    }

    private fun rotateSessionFence(): SessionFence {
        val previous = activeSessionFence
        activeSessionFence = SessionFence()
        previous.invalidate()
        return previous
    }

    /** Closes the ended session's requester, once: a request still in flight finishes and is fenced. */
    private fun endCore() {
        closeChannel()
        configureSessionCoordinators(null)
        core?.requester?.close()
        core = null
    }

    private fun readPersistedVaultDeviceIdForLogout(): String? = synchronized(vaultStateLock) {
        val dir = sessionStateDir
        if (dir != null) {
            val file = SessionStorage.vaultDeviceIdFile(dir)
            val existing = runCatching { file.readText(Charsets.UTF_8).trim() }.getOrNull()
            if (existing != null && TrustPolicy.canonicalNonNilUUID(existing)) {
                return existing
            }
        }
        inMemoryVaultDeviceId
    }

    private fun readPersistedMatrixSessionForLogout(organisationId: String?): PersistedMatrixSession? {
        val orgId = organisationId ?: return null
        val vault = rustSessionVault ?: return null
        val deviceId = readPersistedVaultDeviceIdForLogout() ?: return null
        return runCatching {
            vault.open(orgId, deviceId)?.let(PersistedMatrixSession::decodeVaultBytes)
        }.getOrNull()
    }

    private fun loadOrCreateVaultDeviceId(): String = synchronized(vaultStateLock) {
        val dir = sessionStateDir
        if (dir != null) {
            val file = SessionStorage.vaultDeviceIdFile(dir)
            val existing = runCatching { file.readText(Charsets.UTF_8).trim() }.getOrNull()
            if (existing != null && TrustPolicy.canonicalNonNilUUID(existing)) {
                return existing
            }
            val fresh = UuidV7Identifier.mint().toString()
            runCatching {
                dir.mkdirs()
                file.writeText(fresh, Charsets.UTF_8)
            }
            return fresh
        }
        val mem = inMemoryVaultDeviceId
        if (mem != null) return mem
        return UuidV7Identifier.mint().toString().also { inMemoryVaultDeviceId = it }
    }

    private fun persistPushDeviceId(deviceId: String) {
        synchronized(vaultStateLock) {
            val dir = sessionStateDir ?: return
            runCatching {
                dir.mkdirs()
                SessionStorage.pushDeviceIdFile(dir).writeText(deviceId, Charsets.UTF_8)
            }
        }
    }

    private fun readPersistedPushDeviceId(): String? = synchronized(vaultStateLock) {
        val dir = sessionStateDir ?: return null
        val file = SessionStorage.pushDeviceIdFile(dir)
        if (!file.isFile) return null
        val raw = runCatching { file.readText(Charsets.UTF_8).trim() }.getOrNull() ?: return null
        raw.takeIf { it.isNotEmpty() }
    }

    private fun unwipedMarkerExists(): Boolean = synchronized(vaultStateLock) {
        val dir = sessionStateDir ?: return false
        SessionStorage.unwipedMarkerFile(dir).exists()
    }

    private fun markVaultUnwipedLocked() {
        vaultNotWiped = true
        val dir = sessionStateDir ?: return
        runCatching {
            dir.mkdirs()
            SessionStorage.unwipedMarkerFile(dir).writeText("1", Charsets.UTF_8)
        }
    }

    private fun clearVaultUnwipedMarkerLocked(): Boolean {
        val dir = sessionStateDir ?: run {
            vaultNotWiped = false
            return true
        }
        val marker = SessionStorage.unwipedMarkerFile(dir)
        if (marker.exists() && !marker.delete()) {
            vaultNotWiped = true
            return false
        }
        vaultNotWiped = false
        return true
    }

    private fun wipeVaultBlocking(
        clearPushDeviceId: Boolean,
        retiringFence: SessionFence? = null,
    ): Boolean = synchronized(vaultStateLock) {
        var ok = true
        val vault = rustSessionVault
        if (vault != null) {
            try {
                vault.retireAndWipe {
                    retiringFence?.invalidate()
                }
            } catch (_: TokenStoreException) {
                ok = false
            }
        } else {
            retiringFence?.invalidate()
        }
        inMemoryVaultDeviceId = null
        val dir = sessionStateDir
        if (dir != null) {
            val deviceFile = SessionStorage.vaultDeviceIdFile(dir)
            if (deviceFile.exists() && !deviceFile.delete()) {
                ok = false
            }
            if (clearPushDeviceId) {
                val pushFile = SessionStorage.pushDeviceIdFile(dir)
                if (pushFile.exists() && !pushFile.delete()) {
                    ok = false
                }
            }
        }
        if (ok) {
            if (!clearVaultUnwipedMarkerLocked()) {
                ok = false
            }
        } else {
            markVaultUnwipedLocked()
        }
        ok
    }

    private fun ensurePreviousSessionWipedOnWorker(): Boolean {
        if (!vaultNotWiped && !unwipedMarkerExists()) return true
        return wipeVaultBlocking(clearPushDeviceId = true)
    }

    /** The current session's requester, for host tests. */
    internal val coreRequester: CoreRequester? get() = core?.requester

    /** Shuts the controller's Core clients down; the process's own controller never needs it. */
    override fun close() {
        requireMain()
        if (closed) return
        closed = true
        _isForeground.value = false
        generation = null
        activeMatrixSession = null
        activeMemberProfile = null
        activeMemberOrganisation = null
        activeVaultOrganisationId = null
        rotateSessionFence()
        invalidateRead()
        endCore()
        telecomCoordinator.stop()
        proximityV2Controller.close()
        voluntaryProximityController?.onAuthenticatedRebootstrapRequired = null
        voluntaryProximityController?.close()
        inviteCoordinator.stop()
        passkeyCoordinator.clear()
    }

    private class CoreClients(
        val requester: CoreRequester,
        val me: CoreMeClient,
        val workspace: CoreWorkspaceClient,
        val proximity: CoreProximityClient,
        val pushWakeup: PushWakeupCoordinator,
    )

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
            val radio = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val permissions = RuntimeProximityPermissionChecker(context)
                VoluntaryProximitySessionController(AndroidBleGattProximityDriver(context, permissions),
                    AndroidNsdMdnsProximityDriver(context, permissions), permissions)
            } else null
            return SessionController(
                deployment = deployment,
                backend = backend,
                service = service,
                main = Executor { task -> handler.post(task) },
                onMainThread = { Looper.myLooper() == Looper.getMainLooper() },
                workers = workers,
                voluntaryProximityController = radio,
                rustSessionVault = SessionStorage.rustVault(context),
                sessionStateDir = SessionStorage.sessionDirectory(context.filesDir),
            )
        }
    }
}

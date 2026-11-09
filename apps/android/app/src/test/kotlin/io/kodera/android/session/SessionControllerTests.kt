package io.kodera.android.session

import android.content.Intent
import io.kodera.android.R
import io.kodera.android.auth.AuthorizationPresenter
import io.kodera.android.auth.BrowserAuthorization
import io.kodera.android.auth.BrowserStep
import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.url
import io.kodera.android.client.AuthorizationBackend
import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import io.kodera.android.client.CoreMeClient
import io.kodera.android.client.CoreWorkspaceClient
import io.kodera.android.client.WorkspaceCategory
import io.kodera.android.client.WorkspaceChannel
import io.kodera.android.client.WorkspaceChannelLifecycle
import io.kodera.android.client.WorkspaceFailure
import io.kodera.android.client.WorkspaceOutcome
import io.kodera.android.client.WorkspaceSetup
import io.kodera.android.client.WorkspaceSetupState
import io.kodera.android.client.WorkspaceSnapshot
import io.kodera.android.client.WorkspaceState
import io.kodera.android.client.TransportFailure
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.client.FreshToken
import io.kodera.android.client.InMemoryTokenStore
import io.kodera.android.client.KoderaSignInService
import io.kodera.android.client.MeFailure
import io.kodera.android.client.MeOutcome
import io.kodera.android.client.MemberOrganisation
import io.kodera.android.client.MemberProfile
import io.kodera.android.client.SignInConfiguration
import io.kodera.android.client.SignInService
import io.kodera.android.client.StoredGrant
import io.kodera.android.client.TokenStore
import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.entry.Deployment
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The browser step over the real [BrowserStep], answered by the test. No AppAuth, no Activity: the
 * tests pass no Intent, so an Activity result is always an answer without data.
 */
private class FakeBrowser : AuthorizationBackend, BrowserAuthorization {
    val step = BrowserStep<String>(limitMillis = 10_000)
    private val opened = LinkedBlockingQueue<Unit>()
    /** When set, the sign-in waits on it (bounded) before the browser opens. */
    @Volatile var beforeBrowser: CountDownLatch? = null

    override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant {
        val claim = step.claim() ?: throw BackendException(BackendFailure.UNAVAILABLE)
        try {
            beforeBrowser?.await(5, TimeUnit.SECONDS)
            step.presenting(claim)
            step.ensureLive(claim)
            opened.add(Unit)
            return StoredGrant(issuer.issuer, step.await(claim))
        } finally {
            step.release(claim)
        }
    }

    override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken =
        throw BackendException(BackendFailure.UNAVAILABLE)

    /** Revocation calls: only an explicit sign-out may make one. */
    val revocations = AtomicInteger()

    override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) {
        revocations.incrementAndGet()
    }

    override fun attach(presenter: AuthorizationPresenter) {}
    override fun detach(presenter: AuthorizationPresenter) {}
    override fun onAuthorizationResult(data: Intent?): Boolean = step.deliver(null)
    override fun cancelAuthorization(): Boolean = step.cancel()

    /** The member finished the browser step. */
    fun answer(state: String): Boolean = step.deliver(state)

    fun awaitOpened() {
        check(opened.poll(5, TimeUnit.SECONDS) != null) { "the browser never opened" }
    }
}

/**
 * Core's `/me`, answered from a script in order, counting every fetch. While [hold] is set, a fetch waits on
 * it (bounded) before it answers, so a test can act while that fetch is in flight.
 */
private class ScriptedMe(vararg answers: MeOutcome) {
    private val answers = LinkedBlockingQueue(answers.toList())
    val fetches = AtomicInteger()
    @Volatile var hold: CountDownLatch? = null

    /** Queues one more answer, after those given so far. */
    fun then(answer: MeOutcome) { answers.add(answer) }

    fun fetch(@Suppress("UNUSED_PARAMETER") client: CoreMeClient): MeOutcome {
        fetches.incrementAndGet()
        hold?.await(5, TimeUnit.SECONDS)
        return checkNotNull(answers.poll()) { "no scripted /me answer left" }
    }
}

/** The real service, except that it always claims to hold a session. */
private class ClaimsSignedIn(real: KoderaSignInService) : SignInService by real {
    override val isSignedIn: Boolean get() = true
}

class SessionControllerTests {
    private val issuer = url(ConnectionPolicy.HTTPS, "auth.kodera.test/realms/acme-sa")
    private val client = "test-client"
    private val configuration = SignInConfiguration(client, setOf(url(ConnectionPolicy.HTTPS, "auth.kodera.test")),
        LoopbackPolicy.REFUSE)
    private val mainQueue = LinkedBlockingQueue<Runnable>()
    private val testThread = Thread.currentThread()
    private val workers = Executors.newCachedThreadPool()

    @After fun stopWorkers() { workers.shutdownNow() }

    private fun controller(backend: FakeBrowser, store: TokenStore = InMemoryTokenStore(), core: String? = null,
        service: SignInService = KoderaSignInService(configuration, store, backend), me: ScriptedMe? = null) =
        if (me == null) SessionController(Deployment(null, configuration, core, null), backend, service,
            Executor { task -> mainQueue.add(task) }, { Thread.currentThread() === testThread }, workers)
        else SessionController(Deployment(null, configuration, core, null), backend, service,
            Executor { task -> mainQueue.add(task) }, { Thread.currentThread() === testThread }, workers, me::fetch)

    /** Runs the main-thread tasks queued so far on this thread. */
    private fun runQueuedMainTasks() {
        while (true) (mainQueue.poll() ?: return).run()
    }

    /** Runs the main-thread tasks on this thread until [done] holds; bounded. */
    private fun runMainUntil(label: String, done: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!done()) {
            check(System.nanoTime() < end) { "timed out: $label" }
            mainQueue.poll(20, TimeUnit.MILLISECONDS)?.run()
        }
    }

    private fun signedOut(backend: FakeBrowser): SessionController {
        val session = controller(backend)
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        return session
    }

    private fun waitingOnTheBrowser(backend: FakeBrowser): SessionController {
        val session = signedOut(backend)
        session.signIn(issuer)
        assertEquals(SessionPhase.SigningIn, session.phase)
        backend.awaitOpened()
        return session
    }

    /** The no-organisation state offers the Console only when the build names one, at exactly that origin. */
    @Test fun testTheConsoleActionIsTheDeploymentsOriginOrNone() {
        val backend = FakeBrowser()
        assertNull("a build without a Console origin offers no Console action", controller(backend).consoleOrigin)
        val console = url(ConnectionPolicy.HTTPS, "console.kodera.test")
        val configured = SessionController(Deployment(null, configuration, null, null, console), backend,
            KoderaSignInService(configuration, InMemoryTokenStore(), backend), Executor { task -> mainQueue.add(task) },
            { Thread.currentThread() === testThread }, workers)
        assertEquals(console, configured.consoleOrigin)
    }

    @Test fun testCancelEndsASignInWaitingOnTheBrowser() {
        val backend = FakeBrowser()
        val session = waitingOnTheBrowser(backend)
        session.cancelSignIn()
        runMainUntil("cancelled") { session.phase != SessionPhase.SigningIn }
        assertEquals(SessionPhase.SignedOut, session.phase)
        assertEquals(R.string.signin_cancelled, session.notice)
        assertTrue("a new sign-in can start", session.canSignIn)
        assertTrue("the step is free again", backend.step.claim() != null)
        assertEquals("a cancel revokes nothing", 0, backend.revocations.get())
    }

    @Test fun testOnlySignOutRevokes() {
        val backend = FakeBrowser()
        val session = waitingOnTheBrowser(backend)
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        assertEquals("signing in revokes nothing", 0, backend.revocations.get())
        session.signOut()
        assertEquals(SessionPhase.SignedOut, session.phase)
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (backend.revocations.get() == 0) {
            check(System.nanoTime() < end) { "sign-out never revoked" }
            Thread.sleep(10)
        }
        assertEquals("one revocation, the sign-out's", 1, backend.revocations.get())
    }

    @Test fun testAFreshActivityCancelsASignInNoActivityCanFinish() {
        val backend = FakeBrowser()
        val session = waitingOnTheBrowser(backend)
        session.onActivityCreated(fresh = true, carriesResult = false)
        runMainUntil("cancelled") { session.phase != SessionPhase.SigningIn }
        assertEquals(SessionPhase.SignedOut, session.phase)
        assertEquals("the member did not cancel it", R.string.signin_interrupted, session.notice)
        assertEquals(0, backend.revocations.get())
    }

    @Test fun testARestoredActivityOrOneCarryingTheAnswerLeavesTheSignInOpen() {
        val backend = FakeBrowser()
        val session = waitingOnTheBrowser(backend)
        // A recreated instance receives the result through the registry; one carrying it delivers it.
        session.onActivityCreated(fresh = false, carriesResult = false)
        session.onActivityCreated(fresh = true, carriesResult = true)
        assertTrue("still waiting for the browser", backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        assertNull(session.notice)
    }

    @Test fun testCancelOutsideASignInDoesNothing() {
        val backend = FakeBrowser()
        val session = signedOut(backend)
        session.cancelSignIn()
        session.onActivityCreated(fresh = true, carriesResult = false)
        assertEquals(SessionPhase.SignedOut, session.phase)
        assertNull(session.notice)
    }

    @Test fun testAnUnclaimedResultIsSilentWhileASignInIsPending() {
        val gate = CountDownLatch(1)
        val backend = FakeBrowser().apply { beforeBrowser = gate }
        val session = signedOut(backend)
        session.signIn(issuer)
        // The browser has not opened for this sign-in: the result is left over from an earlier one.
        session.onAuthorizationResult(null)
        assertNull("no notice while a sign-in is pending", session.notice)
        gate.countDown()
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        assertNull(session.notice)
    }

    /** The process died while the browser was open: the result reaches a controller with no sign-in. */
    @Test fun testAnInterruptedStepIsReportedUntilTheNextSignInSucceeds() {
        val backend = FakeBrowser()
        val session = controller(backend)
        session.onAuthorizationResult(null)
        assertEquals("reported while the session is restored", R.string.signin_interrupted, session.notice)
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        assertEquals(R.string.signin_interrupted, session.notice)
        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        assertNull(session.notice)
    }

    /**
     * One requester per session: a reload reuses it, the session's end closes it, and the next session
     * gets its own. The fake identity provider is unreachable, so no Core request is sent.
     */
    @Test fun testEachSessionHasOneCoreRequesterClosedWhenItEnds() {
        val backend = FakeBrowser()
        val session = controller(backend, core = url(ConnectionPolicy.HTTPS, "core.kodera.test"))
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        val first = checkNotNull(session.coreRequester) { "the session has no Core requester" }
        runMainUntil("member settled") { session.member != MemberState.Loading }
        session.reloadMember()
        runMainUntil("member settled again") { session.member != MemberState.Loading }
        assertSame("a reload built a second requester", first, session.coreRequester)
        assertFalse("the live session's requester is closed", first.isClosed)

        session.signOut()
        assertTrue("sign-out left the ended session's requester open", first.isClosed)
        assertNull(session.coreRequester)

        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-2"))
        runMainUntil("signed in again") { session.phase is SessionPhase.SignedIn }
        val second = checkNotNull(session.coreRequester) { "the new session has no Core requester" }
        assertNotSame("the new session reused the ended one's requester", first, second)
        session.close()
        assertTrue("close left the session's requester open", second.isClosed)
        assertNull(session.coreRequester)
    }

    /** Signs in through the fake browser with Core configured; the fake identity provider is unreachable. */
    private fun signedInWithCore(backend: FakeBrowser, service: KoderaSignInService? = null, me: ScriptedMe? = null): SessionController {
        val core = url(ConnectionPolicy.HTTPS, "core.kodera.test")
        val session = if (service == null) controller(backend, core = core, me = me)
            else controller(backend, core = core, service = service, me = me)
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        runMainUntil("member settled") { session.member != MemberState.Loading }
        return session
    }

    /**
     * Owned by the defensive `endCore()` at the top of `enter()`: entering a session twice with no end
     * between closes the first requester, so its OkHttp client and pool are never left open behind it.
     */
    @Test fun testEnteringASessionClosesThePreviousRequester() {
        val backend = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val session = signedInWithCore(backend, service = service)
        val first = checkNotNull(session.coreRequester) { "the session has no Core requester" }

        session.enter(checkNotNull(service.captureAcceptedOwner()), refreshFirst = false)
        val second = checkNotNull(session.coreRequester) { "the second entry has no Core requester" }
        assertNotSame("the second entry kept the first requester", first, second)
        assertTrue("entering again left the previous requester open", first.isClosed)
        assertFalse("the live requester is closed", second.isClosed)
        runMainUntil("member settled") { session.member != MemberState.Loading }
        session.close()
        assertTrue(second.isClosed)
    }

    /**
     * Owned by the `endCore()` in `onSessionEnded()`: a session the service ends on its own (here a
     * sign-out sent to the service directly, as another Core client's second 401 would) closes the
     * session's requester through the session-ended signal, and returns to sign-in.
     */
    @Test fun testASessionEndedByTheServiceClosesItsRequester() {
        val backend = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val session = signedInWithCore(backend, service)
        val requester = checkNotNull(session.coreRequester) { "the session has no Core requester" }
        assertFalse(requester.isClosed)

        // On a worker, bounded: the sign-out blocks, and must not hang the suite.
        workers.submit { service.signOut() }.get(5, TimeUnit.SECONDS)
        runMainUntil("returned to sign-in") { session.phase == SessionPhase.SignedOut }
        assertTrue("the ended session's requester is still open", requester.isClosed)
        assertNull(session.coreRequester)
        assertEquals(R.string.session_ended, session.notice)
    }

    @Test fun testARestoredSessionClearsAnInterruptedNotice() {
        val store = InMemoryTokenStore("""{"version":1,"issuer":"$issuer","state":"grant-1"}""".toByteArray())
        val session = controller(FakeBrowser(), store)
        session.onAuthorizationResult(null)
        assertEquals(R.string.signin_interrupted, session.notice)
        session.start()
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        assertNull("the restored session replaces it", session.notice)
        session.onAuthorizationResult(null)
        assertNull("never reported once signed in", session.notice)
    }

    /**
     * The signal for a session a sign-in replaces comes inside that sign-in, before its browser opens,
     * when the service holds no session. The controller decides on the cause: the sign-in that replaced
     * the session speaks for itself, so the phase stays as it is and nothing is reported as ended.
     */
    @Test fun testASessionReplacedInsideASignInLeavesThePhaseToThatSignIn() {
        val backend = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val session = controller(backend, service = service)
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }
        val signedIn = session.phase

        // A sign-in the controller did not start replaces the session; it waits on the browser.
        val replacing = workers.submit<Unit> { service.signIn(issuer); Unit }
        backend.awaitOpened()
        assertFalse("the replaced session is still held", service.isSignedIn)
        runQueuedMainTasks()
        assertEquals("the replaced session's signal left the phase", signedIn, session.phase)
        assertNull("the replaced session was reported as ended", session.notice)

        assertTrue(backend.answer("grant-2"))
        replacing.get(5, TimeUnit.SECONDS)
        runQueuedMainTasks()
        assertTrue(service.isSignedIn)
        assertEquals(signedIn, session.phase)
    }

    /**
     * Any other cause returns to sign-in while signed in, even when the service says it holds a session:
     * the signal is told at the wipe and queued in order, so it is never a late one from an earlier session.
     */
    @Test fun testTheSignalDecidesOnTheCauseNotOnWhatTheServiceHolds() {
        val backend = FakeBrowser()
        val real = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val session = controller(backend, service = ClaimsSignedIn(real))
        session.start()
        runMainUntil("restored") { session.phase == SessionPhase.SignedOut }
        session.signIn(issuer)
        backend.awaitOpened()
        assertTrue(backend.answer("grant-1"))
        runMainUntil("signed in") { session.phase is SessionPhase.SignedIn }

        workers.submit { real.signOut() }.get(5, TimeUnit.SECONDS)
        runMainUntil("returned to sign-in") { session.phase == SessionPhase.SignedOut }
        assertEquals(R.string.session_ended, session.notice)
    }

    private val forbidden = MeOutcome.Unavailable(MeFailure.Forbidden)

    /** A member Core names, in the realm the test signs in to. */
    private fun member(realm: String) = MeOutcome.Member(MemberProfile("11111111-2222-4333-8444-555555555555",
        "member@example.test", "Synthetic Member", listOf(MemberOrganisation("6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
            "acme-sa", "Synthetic organisation", realm, "org_owner", "active"))))

    /**
     * Owned by `checkMemberAgain()`: an owner who finished their claim in the Console comes back, Core now
     * answers 200, and the screen shows the member, still signed in. From any other state it fetches nothing.
     */
    @Test fun testA403ThenA200OnCheckingAgainReachesTheMember() {
        val me = ScriptedMe(forbidden)
        val session = signedInWithCore(FakeBrowser(), me = me)
        assertEquals(MemberState.NoOrganisationYet, session.member)
        assertEquals(1, me.fetches.get())
        // The claim is finished in the Console: Core now names the member, in the session's own realm.
        me.then(member((session.phase as SessionPhase.SignedIn).session.realm))

        session.checkMemberAgain()
        assertEquals("checking again shows progress", MemberState.Loading, session.member)
        runMainUntil("member settled after checking again") { session.member != MemberState.Loading }
        assertEquals(MemberState.Loaded("Synthetic Member", "Synthetic organisation"), session.member)
        assertTrue("checking again left the session", session.phase is SessionPhase.SignedIn)
        assertEquals(2, me.fetches.get())

        // Only from the no-organisation state: a resume once the member is shown fetches nothing.
        session.checkMemberAgain()
        runQueuedMainTasks()
        assertEquals(MemberState.Loaded("Synthetic Member", "Synthetic organisation"), session.member)
        assertEquals("checking again outside the 403 state fetched", 2, me.fetches.get())
        session.close()
    }

    /**
     * Owned by the guard in `checkMemberAgain()`: a resume and a tap while a fetch is in flight send no second
     * request, and a 403 answer does not fetch again on its own.
     */
    @Test fun testCheckingAgainWhileAFetchIsInFlightSendsNoSecondRequest() {
        val me = ScriptedMe(forbidden, forbidden, forbidden, forbidden, forbidden)
        val session = signedInWithCore(FakeBrowser(), me = me)
        assertEquals(MemberState.NoOrganisationYet, session.member)

        val hold = CountDownLatch(1)
        me.hold = hold
        session.checkMemberAgain()
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (me.fetches.get() < 2) {
            check(System.nanoTime() < end) { "checking again never fetched" }
            Thread.sleep(5)
        }
        // In flight: the app comes back to the foreground, and the member taps Check again twice.
        session.checkMemberAgain()
        session.checkMemberAgain()
        session.checkMemberAgain()
        hold.countDown()
        // The latest fetch's answer is the one shown, so every fetch started has run by now.
        runMainUntil("member settled after checking again") { session.member != MemberState.Loading }
        runQueuedMainTasks()
        assertEquals(MemberState.NoOrganisationYet, session.member)
        assertEquals("a fetch in flight was doubled, or a 403 fetched again on its own", 2, me.fetches.get())
        assertTrue(session.phase is SessionPhase.SignedIn)
        session.close()
    }

    /** Each script item is claimed before it waits: later generations can finish first. */
    private class ReadStep<T>(val answer: T, held: Boolean = false) {
        val entered = CountDownLatch(1)
        val publicationQueued = CountDownLatch(1)
        val release = CountDownLatch(if (held) 1 else 0)
        fun read(): T {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "script answer was never released" }
            return answer
        }
        fun awaitEntered() = check(entered.await(5, TimeUnit.SECONDS)) { "script call never entered" }
    }

    private val workerReadStep = ThreadLocal<ReadStep<*>>()

    private inner class ReadScript<T>(steps: List<ReadStep<T>>) {
        private val steps = LinkedBlockingQueue(steps)
        val calls = AtomicInteger()
        fun read(): T {
            calls.incrementAndGet()
            val step = checkNotNull(steps.poll()) { "unexpected extra request" }
            workerReadStep.set(step)
            return step.read()
        }
    }

    private val organisationA = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    private val organisationB = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e60"
    private val realm = "acme-sa"
    private fun profile(vararg ids: String) = MeOutcome.Member(MemberProfile(
        "11111111-2222-4333-8444-555555555555", "member@example.test", "Synthetic Member",
        ids.map { MemberOrganisation(it, "acme-sa", "Synthetic organisation", realm, "org_owner", "active") }))
    private fun tree(label: String, organisation: String = organisationA) = WorkspaceSnapshot(
        organisation, WorkspaceState.INITIALISED, WorkspaceSetup(WorkspaceSetupState.READY, null), false,
        "0192f3a4-5b6c-7d8e-9f01-23456789abcd", listOf(WorkspaceCategory(
            "0192f3a4-5b6c-7d8e-9f01-23456789abce", "Section", null, listOf(WorkspaceChannel(
                "0192f3a4-5b6c-7d8e-9f01-23456789abcf", ChannelKind.TEXT, label, null, "",
                WorkspaceChannelLifecycle.ACTIVE, ChannelRoomState.READY)))), emptyList())
    private fun loaded(label: String, organisation: String = organisationA): WorkspaceOutcome =
        WorkspaceOutcome.Loaded(tree(label, organisation))

    private inner class ChannelFixture(meSteps: List<ReadStep<MeOutcome>>, channelSteps: List<ReadStep<WorkspaceOutcome>>) {
        val browser = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), browser)
        val me = ReadScript(meSteps)
        val channels = ReadScript(channelSteps)
        val requestedIds = java.util.Collections.synchronizedList(mutableListOf<String>())
        val clients = java.util.Collections.synchronizedList(mutableListOf<CoreWorkspaceClient>())
        val controller = SessionController(Deployment(null, configuration,
            url(ConnectionPolicy.HTTPS, "core.kodera.test"), null), browser, service,
            Executor { task -> mainQueue.add(task) }, { Thread.currentThread() === testThread }, Executor { task ->
                workers.execute {
                    try {
                        task.run()
                        // The real worker has now queued its publication callback, not merely returned a DTO.
                        workerReadStep.get()?.publicationQueued?.countDown()
                    } finally { workerReadStep.remove() }
                }
            },
            fetchMember = { me.read() }, fetchWorkspace = { client, id ->
                clients.add(client); requestedIds.add(id); channels.read()
            })
        init {
            controller.start()
            runMainUntil("restored for channels") { controller.phase == SessionPhase.SignedOut }
            controller.onForeground()
            controller.signIn(issuer)
            browser.awaitOpened()
            assertTrue(browser.answer("grant-channels"))
            runMainUntil("signed in for channels") { controller.phase is SessionPhase.SignedIn }
        }
        fun settled() = runMainUntil("channels settled") {
            controller.workspace is WorkspaceViewState.Loaded || controller.workspace is WorkspaceViewState.Unavailable
        }
        fun label(): String = (controller.workspace as WorkspaceViewState.Loaded).snapshot.categories.first().channels.first().name
        fun reenter() = controller.enter(checkNotNull(service.captureAcceptedOwner()), refreshFirst = false)
    }

    /** Runs the actual queued old publication callback, not merely a wait for a fixture to return. */
    private fun releaseAndPublish(step: ReadStep<*>) {
        runQueuedMainTasks()
        step.release.countDown()
        check(step.publicationQueued.await(5, TimeUnit.SECONDS)) { "old publication callback was never queued" }
        // Drain all queued work, including this known-present publication, before asserting.
        runQueuedMainTasks()
    }

    @Test fun testEachSignedInForegroundEntryRevalidatesMeBeforeWorkspace() {
        val secondMe = ReadStep<MeOutcome>(profile(organisationA), held = true)
        val f = ChannelFixture(listOf(ReadStep(profile(organisationA)), secondMe),
            listOf(ReadStep(loaded("First")), ReadStep(loaded("Second"))))
        f.settled()
        f.controller.onForeground()
        assertEquals(1, f.me.calls.get())
        f.controller.onBackground()
        assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
        f.controller.onForeground()
        assertEquals(MemberState.Loading, f.controller.member)
        assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
        secondMe.awaitEntered()
        assertEquals(1, f.channels.calls.get())
        secondMe.release.countDown()
        f.settled()
        assertEquals("Second", f.label())
        assertEquals(2, f.me.calls.get())
        assertEquals(listOf(organisationA, organisationA), f.requestedIds)
        f.controller.close()
    }

    @Test fun testForegroundAndRetryWhileLoadingDoNotQueueAnotherRead() {
        val me = ReadStep<MeOutcome>(profile(organisationA), held = true)
        val channel = ReadStep(loaded("Current"), held = true)
        val f = ChannelFixture(listOf(me), listOf(channel))
        me.awaitEntered()
        repeat(3) { f.controller.onForeground(); f.controller.retryWorkspace(); f.controller.reloadMember(); f.controller.checkMemberAgain() }
        me.release.countDown()
        runMainUntil("workspace started") { f.controller.workspace == WorkspaceViewState.Loading }
        channel.awaitEntered()
        repeat(3) { f.controller.onForeground(); f.controller.retryWorkspace(); f.controller.reloadMember() }
        channel.release.countDown()
        f.settled()
        runQueuedMainTasks()
        assertEquals(1, f.me.calls.get())
        assertEquals(1, f.channels.calls.get())
        assertEquals("Current", f.label())
        f.controller.close()
    }

    @Test fun testRefusalWaitsForExplicitRetryOrANewForegroundEntry() {
        val refusal: WorkspaceOutcome = WorkspaceOutcome.Unavailable(WorkspaceFailure.Forbidden)
        val f = ChannelFixture(List(3) { ReadStep<MeOutcome>(profile(organisationA)) }, List(3) { ReadStep(refusal) })
        f.settled()
        runQueuedMainTasks()
        f.controller.onForeground()
        assertEquals(1, f.me.calls.get())
        assertEquals(1, f.channels.calls.get())
        f.controller.retryWorkspace()
        f.settled()
        assertEquals(2, f.me.calls.get())
        assertEquals(2, f.channels.calls.get())
        f.controller.onBackground(); f.controller.onForeground()
        f.settled()
        assertEquals(3, f.me.calls.get())
        assertEquals(3, f.channels.calls.get())
        assertTrue(f.controller.phase is SessionPhase.SignedIn)
        assertEquals(0, f.browser.revocations.get())
        f.controller.close()
    }

    @Test fun testBackgroundAndCloseInvalidatePendingPublication() {
        for (close in listOf(false, true)) {
            val old = ReadStep(loaded("Must disappear"), held = true)
            val f = ChannelFixture(List(2) { ReadStep<MeOutcome>(profile(organisationA)) },
                listOf(old, ReadStep(loaded("Foreground"))))
            runMainUntil("loading before departure") { f.controller.workspace == WorkspaceViewState.Loading }
            old.awaitEntered()
            if (close) f.controller.close() else f.controller.onBackground()
            releaseAndPublish(old)
            assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
            f.controller.onForeground()
            if (close) {
                f.controller.retryWorkspace(); f.controller.reloadMember()
                assertEquals(1, f.me.calls.get())
                assertEquals(1, f.channels.calls.get())
            } else {
                f.settled()
                assertEquals("Foreground", f.label())
                assertEquals(2, f.me.calls.get())
            }
            f.controller.close()
        }
    }

    @Test fun testOnlyOneMatchingMembershipCanStartWorkspace() {
        for (ids in listOf(emptyList(), listOf(organisationA, organisationB), listOf(organisationA))) {
            val f = ChannelFixture(listOf(ReadStep<MeOutcome>(profile(*ids.toTypedArray()))), listOf(ReadStep(loaded("Matched"))))
            f.settled()
            assertEquals(if (ids.size == 1) 1 else 0, f.channels.calls.get())
            if (ids.size != 1) {
                assertEquals(MemberState.Loaded("Synthetic Member", null), f.controller.member)
                assertEquals(WorkspaceViewState.Unavailable(R.string.workspace_unavailable), f.controller.workspace)
            } else assertEquals(listOf(organisationA), f.requestedIds)
            f.controller.close()
        }
        val unrelated = profile(organisationB).profile.organisations.first().copy(realm = "other-realm")
        val matched = profile(organisationA)
        val mixed = matched.copy(profile = matched.profile.copy(organisations = listOf(unrelated) + matched.profile.organisations))
        val f = ChannelFixture(listOf(ReadStep<MeOutcome>(mixed)), listOf(ReadStep(loaded("Matched"))))
        f.settled()
        assertEquals(listOf(organisationA), f.requestedIds)
        f.controller.close()
    }

    @Test fun testOldOrganisationAnswerCannotOverwriteRevalidatedTarget() {
        val old = ReadStep(loaded("Old organisation"), held = true)
        val f = ChannelFixture(listOf(ReadStep<MeOutcome>(profile(organisationA)), ReadStep<MeOutcome>(profile(organisationB))),
            listOf(old, ReadStep(loaded("New organisation", organisationB))))
        runMainUntil("old read held") { f.controller.workspace == WorkspaceViewState.Loading }
        old.awaitEntered()
        f.controller.onBackground(); f.controller.onForeground()
        f.settled()
        releaseAndPublish(old)
        assertEquals("New organisation", f.label())
        assertEquals(listOf(organisationA, organisationB), f.requestedIds)
        assertEquals(2, f.channels.calls.get())
        f.controller.close()
    }

    /** Can occur only after the old name actually crossed the completed publication callback. */
    private class OldGenerationPublishedAfterNewGeneration(cause: AssertionError) :
        AssertionError("Old generation replaced New generation", cause)

    @Test fun testSameRealmOldWorkspaceAnswerCannotReplaceNewGeneration() {
        val old = ReadStep(loaded("Old generation"), held = true)
        val f = ChannelFixture(List(2) { ReadStep<MeOutcome>(profile(organisationA)) }, listOf(old, ReadStep(loaded("New generation"))))
        runMainUntil("old read held") { f.controller.workspace == WorkspaceViewState.Loading }
        old.awaitEntered()
        val oldSession = f.controller.phase
        val first = f.controller.coreRequester
        f.reenter()
        assertEquals(oldSession, f.controller.phase)
        assertNotSame(first, f.controller.coreRequester)
        f.settled()
        assertEquals("New generation", f.label())
        releaseAndPublish(old)
        assertTrue(f.service.isSignedIn)
        val observed = f.label()
        try {
            assertEquals("Old generation must not overwrite New generation", "New generation", observed)
        } catch (failure: AssertionError) {
            if (observed == "Old generation") throw OldGenerationPublishedAfterNewGeneration(failure)
            throw failure
        }
        assertEquals(2, f.channels.calls.get())
        f.controller.close()
    }

    @Test fun testOldMeAnswerCannotStartWorkspaceForANewGeneration() {
        val old = ReadStep<MeOutcome>(profile(organisationB), held = true)
        val f = ChannelFixture(listOf(old, ReadStep<MeOutcome>(profile(organisationA))), listOf(ReadStep(loaded("Current"))))
        old.awaitEntered()
        f.reenter()
        f.settled()
        releaseAndPublish(old)
        assertEquals("Current", f.label())
        assertEquals(listOf(organisationA), f.requestedIds)
        assertEquals(1, f.channels.calls.get())
        f.controller.close()
    }

    @Test fun testSignOutReplacementAndEndedSessionClearWorkspace() {
        for (transition in listOf("sign-out", "replace", "ended")) for (held in listOf(false, true)) {
            val answer = ReadStep(loaded("Former"), held = held)
            val f = ChannelFixture(listOf(ReadStep<MeOutcome>(profile(organisationA))), listOf(answer))
            runMainUntil("read started") { f.controller.workspace != WorkspaceViewState.Hidden }
            answer.awaitEntered()
            if (!held) f.settled()
            val first = checkNotNull(f.controller.coreRequester)
            when (transition) {
                "sign-out" -> f.controller.signOut()
                "ended" -> { workers.submit { f.service.signOut() }.get(5, TimeUnit.SECONDS); runQueuedMainTasks() }
                else -> {
                    val replacing = workers.submit<Unit> { f.service.signIn(issuer); Unit }
                    f.browser.awaitOpened()
                    runQueuedMainTasks()
                    assertTrue("replacement must not fabricate sign-out", f.controller.phase is SessionPhase.SignedIn)
                    assertTrue(f.browser.answer("replacement"))
                    replacing.get(5, TimeUnit.SECONDS)
                }
            }
            assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
            assertTrue(first.isClosed)
            if (held) releaseAndPublish(answer)
            assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
            if (transition != "replace") assertEquals(SessionPhase.SignedOut, f.controller.phase)
            f.controller.close()
        }
    }

    @Test fun testWorkspaceOutcomesPreserveMemberAndSessionSemantics() {
        val cases: List<Pair<WorkspaceFailure, Int>> = listOf(WorkspaceFailure.Forbidden to R.string.workspace_unavailable,
            WorkspaceFailure.NotFound to R.string.workspace_unavailable,
            WorkspaceFailure.ProtocolViolation to R.string.workspace_invalid_response,
            WorkspaceFailure.ServiceUnavailable to R.string.workspace_service_unavailable,
            WorkspaceFailure.IdentityUnavailable to R.string.workspace_service_unavailable) +
            TransportFailure.entries.map { WorkspaceFailure.Transport(it) to R.string.workspace_connection_unavailable }
        for ((failure, message) in cases) {
            val f = ChannelFixture(List(2) { ReadStep<MeOutcome>(profile(organisationA)) },
                listOf(ReadStep(loaded("Previously visible")), ReadStep<WorkspaceOutcome>(WorkspaceOutcome.Unavailable(failure))))
            f.settled()
            assertEquals("Previously visible", f.label())
            f.controller.onBackground(); f.controller.onForeground()
            assertEquals(WorkspaceViewState.Hidden, f.controller.workspace)
            f.settled()
            assertEquals(WorkspaceViewState.Unavailable(message), f.controller.workspace)
            assertTrue(f.controller.member is MemberState.Loaded)
            assertTrue(f.controller.phase is SessionPhase.SignedIn)
            assertEquals(0, f.browser.revocations.get())
            assertEquals(2, f.channels.calls.get())
            f.controller.close()
        }
        val current = ChannelFixture(listOf(ReadStep<MeOutcome>(profile(organisationA))),
            listOf(ReadStep<WorkspaceOutcome>(WorkspaceOutcome.SignedOut)))
        current.settled()
        assertEquals(WorkspaceViewState.Unavailable(R.string.workspace_service_unavailable), current.controller.workspace)
        assertTrue(current.controller.phase is SessionPhase.SignedIn)
        current.controller.close()
        // A stale signed-out answer cannot sign out a newer, otherwise identical session.
        val old = ReadStep<WorkspaceOutcome>(WorkspaceOutcome.SignedOut, held = true)
        val f = ChannelFixture(List(2) { ReadStep<MeOutcome>(profile(organisationA)) }, listOf(old, ReadStep(loaded("Survivor"))))
        runMainUntil("signed-out answer held") { f.controller.workspace == WorkspaceViewState.Loading }
        old.awaitEntered(); f.reenter(); f.settled(); releaseAndPublish(old)
        assertEquals("Survivor", f.label())
        assertTrue(f.controller.phase is SessionPhase.SignedIn)
        f.controller.close()
    }

    @Test fun testWorkspaceMetadataStatesRetainOrderWithoutActions() {
        val base = tree("First")
        val second = base.categories.first().channels.first().copy(name = "Second", roomState = ChannelRoomState.FAILED)
        val ordered = base.copy(uncategorisedChannels = listOf(second))
        val snapshots = listOf(ordered, base.copy(categories = emptyList()), base.copy(
            state = WorkspaceState.NOT_INITIALISED, id = null, categories = emptyList())) +
            WorkspaceSetupState.entries.map { base.copy(setup = WorkspaceSetup(it, null)) }
        for (snapshot in snapshots) {
            val f = ChannelFixture(listOf(ReadStep<MeOutcome>(profile(organisationA))),
                listOf(ReadStep<WorkspaceOutcome>(WorkspaceOutcome.Loaded(snapshot))))
            f.settled()
            assertEquals(snapshot, (f.controller.workspace as WorkspaceViewState.Loaded).snapshot)
            f.controller.close()
        }
        assertEquals(R.string.workspace_room_ready, workspaceRoomLabel(ChannelRoomState.READY))
        assertEquals(R.string.workspace_room_pending, workspaceRoomLabel(ChannelRoomState.PENDING))
        assertEquals(R.string.workspace_room_failed, workspaceRoomLabel(ChannelRoomState.FAILED))
    }

    @Test fun testWorkspaceUsesOnlyTheCurrentSessionsSharedRequester() {
        val f = ChannelFixture(List(3) { ReadStep<MeOutcome>(profile(organisationA)) },
            List(3) { ReadStep(loaded("Current")) })
        f.settled()
        val requester = f.controller.coreRequester
        f.controller.retryWorkspace(); f.settled()
        assertSame(requester, f.controller.coreRequester)
        assertSame(f.clients[0], f.clients[1])
        f.reenter(); f.settled()
        assertNotSame(requester, f.controller.coreRequester)
        assertNotSame(f.clients[0], f.clients[2])
        assertTrue(checkNotNull(requester).isClosed)
        f.controller.signOut()
        f.controller.retryWorkspace(); f.controller.onForeground()
        assertEquals(3, f.channels.calls.get())
        f.controller.close()
    }
    @Test fun delayedServiceEndIsBoundToItsReceiptInsteadOfCurrentPublicSession() {
        val backend = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val scripted = ScriptedMe(member("acme-sa"), member("acme-sa"))
        val controller = signedInWithCore(backend, service, scripted)
        try {
            val initial = controller.phase as SessionPhase.SignedIn
            val result = workers.submit<io.kodera.android.client.AcceptedOwner> { service.signInAccepted(issuer) }
            backend.awaitOpened(); assertTrue(backend.answer("grant-replacement"))
            val replacement = result.get(5, TimeUnit.SECONDS)
            assertEquals(initial.session, replacement.session)
            assertTrue("old end must be queued", mainQueue.isNotEmpty())
            controller.enter(replacement, refreshFirst = false)
            val requester = controller.coreRequester
            runMainUntil("replacement member settled") { controller.member != MemberState.Loading }
            runQueuedMainTasks()
            assertEquals(SessionPhase.SignedIn(replacement.session), controller.phase)
            assertSame(requester, controller.coreRequester)
            assertFalse(checkNotNull(requester).isClosed)
        } finally { controller.close() }
    }

    @Test fun retiredRestoreAtEntryAdmissionSettlesPending() = pendingEntryRetirement(restore = true)
    @Test fun retiredSignInAtEntryAdmissionSettlesPending() = pendingEntryRetirement(restore = false)

    /** Defensive internal-entry contract; production's thread predicate does not reenter the controller. */
    @Test fun declinedOldEntryCannotClearAcceptedG2() = pendingEntryRetirement(restore = true, replace = true)

    private fun pendingEntryRetirement(restore: Boolean, replace: Boolean = false) {
        val backend = FakeBrowser()
        val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
        val submitted = java.util.concurrent.CopyOnWriteArrayList<java.util.concurrent.FutureTask<Unit>>()
        var armed: (() -> Unit)? = null
        val controller = SessionController(Deployment(null, configuration,
            url(ConnectionPolicy.HTTPS, "core.kodera.test"), null), backend, service,
            Executor { mainQueue.add(it) }, {
                val actualMainThread = Thread.currentThread() === testThread
                if (actualMainThread) {
                    val action = armed
                    armed = null // Disarm before the real service operation or defensive nested entry.
                    action?.invoke()
                }
                actualMainThread // Wrong-thread calls still fail the real requireMain assertion.
            }, Executor { task ->
                val future = java.util.concurrent.FutureTask<Unit>(java.util.concurrent.Callable { task.run(); Unit })
                submitted += future
                workers.execute(future)
            }, fetchMember = { member("acme-sa") })
        var browserWorker: java.util.concurrent.Future<io.kodera.android.client.AcceptedOwner>? = null
        var retirementWorker: java.util.concurrent.Future<*>? = null
        try {
            if (restore) {
                browserWorker = workers.submit<io.kodera.android.client.AcceptedOwner> { service.signInAccepted(issuer) }
                backend.awaitOpened(); assertTrue(backend.answer("grant-entry-G1"))
                browserWorker.get(5, TimeUnit.SECONDS)
                controller.start()
            } else {
                controller.start()
                runMainUntil("empty restore before pending sign-in") { controller.phase == SessionPhase.SignedOut }
                controller.signIn(issuer)
                backend.awaitOpened(); assertTrue(backend.answer("grant-entry-G1"))
            }
            val delivery = checkNotNull(mainQueue.poll(5, TimeUnit.SECONDS)) { "actual accepted owner main delivery missing" }
            submitted.toList().forEach { it.get(5, TimeUnit.SECONDS) }
            val first = checkNotNull(service.captureAcceptedOwner())
            assertFalse("precondition: G1 is live before outer pending handler", first.isRetired)
            assertEquals(if (restore) SessionPhase.Restoring else SessionPhase.SigningIn, controller.phase)
            assertNull(controller.coreRequester)
            var gateCount = 0
            var endedQueued = false
            var replacement: io.kodera.android.client.AcceptedOwner? = null
            var replacementRequester: io.kodera.android.client.CoreRequester? = null
            armed = {
                gateCount++
                assertSame(testThread, Thread.currentThread())
                assertFalse("precondition: outer retired read admitted live G1", first.isRetired)
                if (replace) {
                    browserWorker = workers.submit<io.kodera.android.client.AcceptedOwner> { service.signInAccepted(issuer) }
                    backend.awaitOpened(); assertTrue(backend.answer("grant-entry-G2"))
                    replacement = browserWorker!!.get(5, TimeUnit.SECONDS)
                    assertEquals(first.session, replacement!!.session)
                } else {
                    retirementWorker = workers.submit { service.signOut() }
                    retirementWorker!!.get(5, TimeUnit.SECONDS)
                }
                assertTrue("real service worker must retire G1 before inner admission", first.isRetired)
                endedQueued = mainQueue.isNotEmpty()
                assertTrue("exact G1 end delivery must be queued", endedQueued)
                if (replace) {
                    controller.enter(checkNotNull(replacement), refreshFirst = false)
                    replacementRequester = controller.coreRequester
                }
            }
            delivery.run() // Outer retired read -> existing thread predicate -> inner entry guard.
            submitted.toList().forEach { it.get(5, TimeUnit.SECONDS) }
            runQueuedMainTasks() // A discarded exact-owner end cannot rescue a null generation.
            assertEquals("existing predicate retirement action must run once", 1, gateCount)
            assertTrue(first.isRetired)
            assertTrue(endedQueued)
            if (replace) {
                val current = checkNotNull(replacement)
                assertEquals(SessionPhase.SignedIn(current.session), controller.phase)
                assertSame(current, service.captureAcceptedOwner())
                assertSame(replacementRequester, controller.coreRequester)
                assertFalse(checkNotNull(replacementRequester).isClosed)
                assertEquals(MemberState.Loaded("Synthetic Member", "Synthetic organisation"), controller.member)
            } else {
                val path = if (restore) "restore" else "sign-in"
                assertEquals("retired $path entry left controller pending", SessionPhase.SignedOut, controller.phase)
                assertNull(controller.coreRequester)
                assertEquals(MemberState.Loading, controller.member)
                assertEquals(R.string.session_ended, controller.notice)
            }
        } finally {
            armed = null
            controller.close()
            backend.cancelAuthorization()
            browserWorker?.get(5, TimeUnit.SECONDS)
            retirementWorker?.get(5, TimeUnit.SECONDS)
            submitted.toList().forEach { it.get(5, TimeUnit.SECONDS) }
            runQueuedMainTasks()
        }
    }

}

package io.kodera.android.session

import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.url
import io.kodera.android.client.AuthorizationBackend
import io.kodera.android.client.CoreMeClient
import io.kodera.android.client.FreshToken
import io.kodera.android.client.InMemoryTokenStore
import io.kodera.android.client.KoderaSignInService
import io.kodera.android.client.MeOutcome
import io.kodera.android.client.SignInConfiguration
import io.kodera.android.client.StoredGrant
import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.entry.Deployment
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Actual Debug controller, service, requester and parser. No provider or device evidence. */
class SessionOwnerBindingTests {
    @Test fun retiredOpenRequesterNeverBorrowsReplacementGrant() {
        OwnerHttpFixture().use { wire ->
            val issuer = url(ConnectionPolicy.HTTPS, "auth.kodera.test/realms/acme-sa")
            val client = "synthetic-client"
            val configuration = SignInConfiguration(client, setOf(url(ConnectionPolicy.HTTPS, "auth.kodera.test")), LoopbackPolicy.REFUSE)
            val backend = OwnerBackend(issuer)
            val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
            val workers = Executors.newFixedThreadPool(2)
            val main = LinkedBlockingQueue<Runnable>()
            val serial = Thread.currentThread()
            val controller = SessionController(Deployment(null, configuration, wire.origin, null), null, service,
                Executor { main.add(it) }, { Thread.currentThread() === serial }, workers)
            try {
                val g1 = workers.submit<io.kodera.android.client.Session> { service.signIn(issuer) }.get(5, TimeUnit.SECONDS)
                controller.start()
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (controller.member !is MemberState.Loaded) {
                    check(System.nanoTime() < deadline) { "G1 actual controller /me did not settle" }
                    checkNotNull(main.poll(5, TimeUnit.SECONDS)) { "G1 main delivery missing" }.run()
                }
                val r1 = checkNotNull(controller.coreRequester)
                assertFalse("precondition: G1 requester must remain open", r1.isClosed)
                assertTrue("precondition: actual G1 HTTP/parser succeeded", wire.requests.any { it.authorization == "Bearer synthetic-G1" })
                val g2 = workers.submit<io.kodera.android.client.Session> { service.signIn(issuer) }.get(5, TimeUnit.SECONDS)
                assertEquals("precondition: identical public session", g1, g2)
                assertEquals("precondition: actual service accepted replacement", 2, backend.accepted.get())
                assertTrue("precondition: old end delivery must remain queued", main.isNotEmpty())
                assertFalse("precondition: closure must not mask receipt admission", r1.isClosed)
                val backendBefore = backend.grants.size
                val httpBefore = wire.requests.size
                workers.submit<MeOutcome> { CoreMeClient(r1).fetch() }.get(10, TimeUnit.SECONDS)
                assertEquals("retired open G1 requester acquired the replacement G2 grant", backendBefore, backend.grants.size)
                assertEquals("retired open G1 requester sent new HTTP", httpBefore, wire.requests.size)
            } finally {
                controller.close()
                workers.shutdownNow()
                assertTrue("controller workers must terminate", workers.awaitTermination(5, TimeUnit.SECONDS))
            }
        }
    }
    @Test fun retiredRestoreAcceptanceCannotEnterOrLeaveLaunchStuck() {
        OwnerHttpFixture().use { wire ->
            OwnerApp(wire, manualWorkers = true).use { app ->
                app.accept()
                app.controller.start()
                app.work.runNext()
                app.work.awaitAll() // G1 receipt returned; its main acceptance remains queued.
                val replacement = app.accept()
                app.drainMain()
                assertEquals(SessionPhase.SignedOut, app.controller.phase)
                assertNull(app.controller.coreRequester)
                assertTrue(app.backend.grants.isEmpty())
                assertTrue(wire.requests.isEmpty())
                app.controller.enter(replacement, refreshFirst = false)
                app.work.runNext()
                app.pumpUntil { app.controller.member is MemberState.Loaded }
                assertFalse(replacement.isRetired)
                assertTrue(wire.requests.any { it.authorization == "Bearer synthetic-G2" })
            }
        }
    }

    @Test fun retiredLaunchRefreshNeverBorrowsReplacementGrant() {
        OwnerHttpFixture().use { wire ->
            OwnerApp(wire, manualWorkers = true).use { app ->
                app.accept()
                app.controller.start()
                app.work.runNext()
                app.work.awaitAll()
                app.drainMain() // enter(G1) queues its launch refresh; deliberately not run yet.
                val r1 = checkNotNull(app.controller.coreRequester)
                val replacement = app.accept()
                assertFalse(r1.isClosed)
                assertTrue(app.main.isNotEmpty())
                app.work.runNext()
                app.work.awaitAll()
                assertTrue("retired launch refreshed replacement G2 grant", app.backend.grants.isEmpty())
                assertTrue(wire.requests.isEmpty())
                app.drainMain()
                app.controller.enter(replacement, refreshFirst = false)
                app.work.runNext()
                app.pumpUntil { app.controller.member is MemberState.Loaded }
                assertEquals(listOf("G2"), app.backend.grants.toList())
            }
        }
    }

    @Test fun heldOldHttpDataAndEndDeliveryCannotReplaceSamePublicG2() {
        OwnerHttpFixture().use { wire ->
            OwnerApp(wire).use { app ->
                val initial = app.accept()
                app.controller.start()
                app.pumpUntil { app.controller.member is MemberState.Loaded }
                val oldRequester = checkNotNull(app.controller.coreRequester)
                val hold = wire.holdNext("Bearer synthetic-G1", "/api/v1/me")
                try {
                    app.controller.onForeground()
                    assertTrue("actual G1 HTTP must be held", hold.entered.await(5, TimeUnit.SECONDS))
                    val replacement = app.accept()
                    assertEquals(initial.session, replacement.session)
                    assertFalse("old main end has not closed R1 yet", oldRequester.isClosed)
                    app.controller.enter(replacement, refreshFirst = false)
                    app.pumpUntil { app.controller.workspace is WorkspaceViewState.Loaded }
                    assertEquals(MemberState.Loaded("G2", "Synthetic organisation"), app.controller.member)
                    assertEquals("G2", app.label())
                    val currentRequester = app.controller.coreRequester
                    hold.release.countDown()
                    app.work.awaitAll()
                    app.drainMain()
                    assertSame(currentRequester, app.controller.coreRequester)
                    assertFalse(checkNotNull(currentRequester).isClosed)
                    assertEquals("G2", app.label())
                    assertEquals(SessionPhase.SignedIn(replacement.session), app.controller.phase)
                    assertEquals(listOf("/api/v1/me", "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/workspace"),
                        wire.requests.filter { it.authorization == "Bearer synthetic-G2" }.map { it.target })
                } finally { hold.release.countDown() }
            }
        }
    }

}

private class OwnerBackend(private val issuer: String) : AuthorizationBackend {
    val accepted = AtomicInteger()
    val grants = CopyOnWriteArrayList<String>()
    override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant =
        StoredGrant(this.issuer, "G${accepted.incrementAndGet()}")
    override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken {
        grants += grant.state
        return FreshToken("synthetic-${grant.state}", grant)
    }
    override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) {}
}

private data class OwnerRequest(val target: String, val authorization: String?)

/** Private Debug-only finite plain-HTTP fixture; Release trust configuration stays untouched. */
private class OwnerHttpFixture : AutoCloseable {
    private val server = ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))
    val origin = url("http", "127.0.0.1:${server.localPort}")
    val requests = CopyOnWriteArrayList<OwnerRequest>()
    private val errors = CopyOnWriteArrayList<Throwable>()
    private val sockets = CopyOnWriteArrayList<Socket>()
    private val peers = Executors.newFixedThreadPool(2)
    private val slots = java.util.concurrent.Semaphore(2)
    private val pendingHold = java.util.concurrent.atomic.AtomicReference<OwnerHold?>()
    fun holdNext(authorization: String, target: String): OwnerHold = OwnerHold(authorization, target).also {
        check(pendingHold.compareAndSet(null, it))
    }
    @Volatile private var closed = false
    private val acceptor = Thread({
        try {
            while (!closed) {
                val socket = server.accept().also { it.soTimeout = 5000; sockets += it }
                check(slots.tryAcquire(5, TimeUnit.SECONDS)) { "More than two concurrent HTTP fixture peers" }
                peers.execute {
                    try { socket.use { answer(it) } }
                    catch (error: Throwable) { if (!closed) errors += error }
                    finally { slots.release() }
                }
            }
        } catch (error: SocketException) { if (!closed) errors += error }
    }, "kodera-owner-http").apply { start() }

    private fun answer(socket: Socket) {
        val input = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
        val requestLine = checkNotNull(input.readLine())
        check(requestLine.length < 4096)
        val target = requestLine.split(' ')[1]
        var authorization: String? = null
        repeat(32) {
            val line = checkNotNull(input.readLine())
            check(line.length < 4096)
            if (line.isEmpty()) {
                requests += OwnerRequest(target, authorization)
                val hold = pendingHold.get()
                if (hold != null && hold.authorization == authorization && hold.target == target && pendingHold.compareAndSet(hold, null)) {
                    hold.entered.countDown()
                    check(hold.release.await(10, TimeUnit.SECONDS)) { "held HTTP not released" }
                }
                val label = authorization?.removePrefix("Bearer synthetic-") ?: "Missing"
                val body = if (target == "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/workspace") {
                    """{"organisation_id":"6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f","state":"initialised",
                    "setup":{"state":"ready","reason":null},"can_initialise":false,"id":"0192f3a4-5b6c-7d8e-9f01-23456789abcd",
                    "categories":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abce","name":"Synthetic","template_key":null,
                    "channels":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abcf","kind":"text","name":"$label","template_key":null,
                    "topic":"","lifecycle":"active","room_state":"ready"}]}],"uncategorised_channels":[]}"""
                } else {
                    check(target == "/api/v1/me") { "Unexpected fixture target: $target" }
                    """{"id":"11111111-2222-4333-8444-555555555555","email":"member@example.test",
                    "display_name":"$label","organisations":[{"organisation":{
                    "id":"6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f","slug":"acme-sa","name":"Synthetic organisation","realm":"acme-sa"},
                    "role":"org_member","state":"active"}]}"""
                }.toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                socket.getOutputStream().apply { write(head.toByteArray(Charsets.US_ASCII)); write(body); flush() }
                return
            }
            if (line.startsWith("Authorization:", ignoreCase = true)) authorization = line.substringAfter(':').trim()
        }
        error("Too many fixture request headers")
    }

    override fun close() {
        closed = true
        pendingHold.getAndSet(null)?.release?.countDown()
        server.close()
        sockets.forEach { it.close() }
        peers.shutdownNow()
        acceptor.join(5000)
        check(!acceptor.isAlive) { "fixture acceptor must terminate" }
        check(peers.awaitTermination(5, TimeUnit.SECONDS)) { "fixture peers must terminate" }
        check(errors.isEmpty()) { "unexpected fixture failure: ${errors.firstOrNull()?.javaClass?.simpleName}" }
    }
}

private class OwnerHold(val authorization: String, val target: String) {
    val entered = java.util.concurrent.CountDownLatch(1)
    val release = java.util.concurrent.CountDownLatch(1)
}

private class OwnerWork(private val manual: Boolean) : Executor, AutoCloseable {
    val pool = Executors.newFixedThreadPool(2)
    private val pending = LinkedBlockingQueue<Runnable>()
    private val futures = CopyOnWriteArrayList<java.util.concurrent.Future<*>>()
    override fun execute(command: Runnable) {
        if (manual) pending.add(command) else futures += pool.submit(command)
    }
    fun runNext() { futures += pool.submit(checkNotNull(pending.poll()) { "missing controlled App worker" }) }
    fun awaitAll() { futures.toList().forEach { it.get(10, TimeUnit.SECONDS) } }
    override fun close() {
        try {
            while (pending.isNotEmpty()) runNext()
            awaitAll()
        } finally {
            pool.shutdownNow()
            check(pool.awaitTermination(5, TimeUnit.SECONDS)) { "App workers must terminate" }
        }
    }
}

private class OwnerApp(wire: OwnerHttpFixture, manualWorkers: Boolean = false) : AutoCloseable {
    private val issuer = url(ConnectionPolicy.HTTPS, "auth.kodera.test/realms/acme-sa")
    private val client = "synthetic-client"
    private val configuration = SignInConfiguration(client, setOf(url(ConnectionPolicy.HTTPS, "auth.kodera.test")), LoopbackPolicy.REFUSE)
    val backend = OwnerBackend(issuer)
    val service = KoderaSignInService(configuration, InMemoryTokenStore(), backend)
    val work = OwnerWork(manualWorkers)
    val main = LinkedBlockingQueue<Runnable>()
    private val serial = Thread.currentThread()
    val controller = SessionController(Deployment(null, configuration, wire.origin, null), null, service,
        Executor { main.add(it) }, { Thread.currentThread() === serial }, work)
    fun accept(): io.kodera.android.client.AcceptedOwner =
        work.pool.submit<io.kodera.android.client.AcceptedOwner> { service.signInAccepted(issuer) }.get(5, TimeUnit.SECONDS)
    fun pumpUntil(done: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!done()) {
            check(System.nanoTime() < deadline) { "App state did not settle" }
            checkNotNull(main.poll(5, TimeUnit.SECONDS)) { "missing actual App main delivery" }.run()
        }
    }
    fun drainMain() {
        var remaining = 100
        while (true) {
            val task = main.poll() ?: return
            check(remaining-- > 0); task.run()
        }
    }
    fun label() = (controller.workspace as WorkspaceViewState.Loaded).snapshot.categories.single().channels.single().name
    override fun close() { controller.close(); work.close() }
}

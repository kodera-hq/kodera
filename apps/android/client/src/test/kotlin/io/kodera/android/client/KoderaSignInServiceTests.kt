package io.kodera.android.client

import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.GeneralSecurityException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** A scripted backend: no browser, no network. */
internal class FakeBackend(@Volatile var authorizeResult: () -> StoredGrant) : AuthorizationBackend {
    val refreshResults = CopyOnWriteArrayList<() -> FreshToken>()
    val authorized = CopyOnWriteArrayList<AdmittedIssuer>()
    val refreshes = CopyOnWriteArrayList<Pair<StoredGrant, Boolean>>()
    val revoked = CopyOnWriteArrayList<StoredGrant>()
    private val inFlight = AtomicInteger()
    val maxInFlight = AtomicInteger()

    override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant {
        authorized += issuer
        return authorizeResult()
    }

    override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken {
        val now = inFlight.incrementAndGet()
        maxInFlight.accumulateAndGet(now, ::maxOf)
        try {
            refreshes += grant to forceRefresh
            Thread.sleep(20)
            if (refreshResults.isEmpty()) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
            return refreshResults.removeAt(0)()
        } finally { inFlight.decrementAndGet() }
    }

    @Volatile var onRevoke: () -> Unit = {}
    override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) { onRevoke(); revoked += grant }
}

private class FailingStore : TokenStore {
    override fun load(): ByteArray? = throw TokenStoreException("load")
    override fun save(data: ByteArray) = throw TokenStoreException("save")
    override fun wipe() {}
}

/** Loads nothing and refuses every save: no grant can be kept. */
private class RefusesSaveStore : TokenStore {
    override fun load(): ByteArray? = null
    override fun save(data: ByteArray) = throw TokenStoreException("save")
    override fun wipe() {}
}

/** Keeps the first grant it is given and refuses every later save, as a store that cannot take the rotated grant. */
private class RefusesRotationStore : TokenStore {
    private val inner = InMemoryTokenStore()
    override fun load(): ByteArray? = inner.load()
    override fun save(data: ByteArray) { if (inner.saves == 0) inner.save(data) else throw TokenStoreException("save") }
    override fun wipe() = inner.wipe()
}

/**
 * The sealed store whose file delete fails: its wipe destroys the key, then throws, and the file it left
 * can never be read again. A save makes a new key.
 */
private class UndeletableSealedStore : TokenStore {
    private var data: ByteArray? = null
    private var keyGone = false
    override fun load(): ByteArray? = synchronized(this) {
        if (data != null && keyGone) throw TokenStoreException("no key")
        data?.copyOf()
    }
    override fun save(data: ByteArray) { synchronized(this) { this.data = data.copyOf(); keyGone = false } }
    override fun wipe() { synchronized(this) { keyGone = true }; throw TokenStoreException("delete") }
}

/** A real software sealing key whose injected destruction failure leaves the original key intact. */
private class RetainedSessionKeys : SessionKeys {
    var failDestroy = false
    var destroyAttempts = 0
    var key: SecretKey? = null
        private set
    override fun existing(): SecretKey? = key
    override fun getOrCreate(): SecretKey = key ?: KeyGenerator.getInstance("AES").apply { init(256) }
        .generateKey().also { key = it }
    override fun destroy() {
        destroyAttempts++
        if (failDestroy) throw GeneralSecurityException("injected key deletion failure")
        key = null
    }
}

/** Ordinary file reads/writes, with only deletion refused when the test explicitly asks for it. */
private class RetainedSessionFile(parent: File) : File(parent, "core-session.bin") {
    var refuseDelete = false
    var deleteAttempts = 0
    override fun delete(): Boolean {
        deleteAttempts++
        return if (refuseDelete) false else super.delete()
    }
}

/**
 * Records the session-ended signals, with what the store held and how many browser steps the backend had
 * opened when each was told. A listener runs synchronously inside the call that ended the session, so the
 * log is final once that call returns: no test here waits for it.
 */
private class EndedLog(private val store: TokenStore?, private val backend: FakeBackend?) {
    private val events = mutableListOf<SessionEnded>()
    /** Whether the store held anything when each signal was told. */
    val storedAt = CopyOnWriteArrayList<Boolean>()
    /** How many sign-ins had reached the browser step when each signal was told. */
    val browsersAt = CopyOnWriteArrayList<Int>()
    private var mark = 0

    fun record(event: SessionEnded) {
        storedAt += try { store?.load() != null } catch (_: TokenStoreException) { true }
        browsersAt += backend?.authorized?.size ?: -1
        synchronized(this) { events += event }
    }

    /** The signals since the last call: each assertion counts only what the step before it did. */
    fun sinceLast(): List<SessionEnded> = synchronized(this) { events.drop(mark).also { mark = events.size } }
}

private fun failing(failure: BackendFailure): () -> Nothing = { throw BackendException(failure) }

class KoderaSignInServiceTests {
    private val issuer = "https://auth.kodera.test/realms/acme-sa"
    private val grant = StoredGrant(issuer, "grant-1")
    private val rotated = StoredGrant(issuer, "grant-2")

    private fun configuration(loopback: LoopbackPolicy = LoopbackPolicy.REFUSE, origins: Set<String> = setOf("https://auth.kodera.test")) =
        SignInConfiguration("kodera-android", origins, loopback)

    private fun signedIn(backend: FakeBackend, store: TokenStore = InMemoryTokenStore(),
        signOutWaitMillis: Long = KoderaSignInService.SIGN_OUT_WAIT_MILLIS): KoderaSignInService {
        val service = KoderaSignInService(configuration(), store, backend, signOutWaitMillis)
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        return service
    }

    /** The production encrypted store and service; only the key/file operations are fault-injected. */
    private inner class SealedWipeFixture : AutoCloseable {
        val directory: File = Files.createTempDirectory("kodera-ended-session").toFile()
        val file = RetainedSessionFile(directory)
        val keys = RetainedSessionKeys()
        val store = EncryptedFileTokenStore(file, keys)
        val backend = FakeBackend { grant }
        val service = signedIn(backend, store)
        val events = mutableListOf<SessionEnded>()
        val originalSealed: ByteArray = file.readBytes()
        val originalPlaintext: ByteArray = checkNotNull(store.load())
        val originalKey: SecretKey = checkNotNull(keys.existing())

        init { service.addSessionEndedListener { events += it } }

        fun end(failKey: Boolean, failFile: Boolean) {
            keys.failDestroy = failKey
            file.refuseDelete = failFile
            service.signOut()
            assertFalse("sign-out did not end memory", service.isSignedIn)
            assertEquals("wrong initial key-attempt count", 1, keys.destroyAttempts)
            assertEquals("wrong initial file-attempt count", 1, file.deleteAttempts)
            assertEquals("sign-out did not report exactly one end", 1, events.size)
            assertEquals(SessionEndCause.EXPLICIT_SIGN_OUT, events.single().cause)
            assertEquals("unexpected authorization", 1, backend.authorized.size)
            assertTrue("setup unexpectedly refreshed", backend.refreshes.isEmpty())
            assertEquals("explicit sign-out did not revoke once", listOf(grant), backend.revoked.toList())
        }

        fun assertOriginalStillReadable() {
            assertTrue("injected key failure removed the key", keys.existing() === originalKey)
            assertTrue("injected delete failure removed the file", file.isFile)
            assertTrue("the original sealed bytes changed", originalSealed.contentEquals(file.readBytes()))
            val fromFreshStore = EncryptedFileTokenStore(file, keys).load()
            assertTrue("the original ciphertext is not actually readable",
                fromFreshStore != null && originalPlaintext.contentEquals(fromFreshStore))
        }

        override fun close() {
            keys.failDestroy = false
            file.refuseDelete = false
            try { store.wipe() } finally { directory.deleteRecursively() }
        }
    }

    private fun signInFailure(block: () -> Unit): SignInFailure {
        try { block() } catch (error: SignInException) { return error.failure }
        fail("sign-in succeeded"); throw AssertionError()
    }

    /**
     * Until [worker] is parked in a timed wait (sign-out waiting on the refresh lock, after it read the
     * generation; sign-in waiting for a revocation); past two seconds the test fails with [what].
     */
    private fun awaitTimedWait(worker: Thread, what: String = "sign-out never waited for the refresh") {
        val end = System.nanoTime() + 2_000_000_000L
        while (worker.state != Thread.State.TIMED_WAITING) {
            check(System.nanoTime() < end) { what }
            Thread.yield()
        }
    }

    private fun tokenFailure(block: () -> Unit): AccessTokenFailure {
        try { block() } catch (error: AccessTokenException) { return error.failure }
        fail("token issued"); throw AssertionError()
    }

    // trust

    @Test fun testUntrustedIssuerNeverReachesTheBackend() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = KoderaSignInService(configuration(), store, backend)
        for (candidate in listOf("https://evil.test/realms/acme-sa", "https://auth.kodera.test:8443/realms/acme-sa",
                "http://auth.kodera.test/realms/acme-sa", "https://auth.kodera.test/realms/acme-sa/x")) {
            assertEquals(candidate, SignInFailure.UNTRUSTED_ISSUER, signInFailure { service.signIn(candidate) })
        }
        assertTrue(backend.authorized.isEmpty())
        assertNull(store.load())
    }

    @Test fun testLoopbackIssuerNeedsTheDevelopmentPolicy() {
        assertEquals(SignInFailure.NOT_CONFIGURED, signInFailure {
            configuration(LoopbackPolicy.REFUSE, setOf("http://localhost:8080"))
        })
        val backend = FakeBackend { StoredGrant("http://localhost:8080/realms/kodera-dev", "g") }
        val service = KoderaSignInService(configuration(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT, setOf("http://localhost:8080")),
            InMemoryTokenStore(), backend)
        assertEquals("kodera-dev", service.signIn("http://localhost:8080/realms/kodera-dev").realm)
    }

    @Test fun testConfigurationRefusesAnEmptyOrUnprintableClient() {
        for (client in listOf("", "kodera android", "kodera-android\n", "a".repeat(129))) {
            assertEquals(client, SignInFailure.NOT_CONFIGURED, signInFailure {
                SignInConfiguration(client, setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE)
            })
        }
        assertEquals(SignInFailure.NOT_CONFIGURED, signInFailure { SignInConfiguration("kodera-android", emptySet(), LoopbackPolicy.REFUSE) })
        assertEquals(SignInFailure.NOT_CONFIGURED, signInFailure {
            SignInConfiguration("kodera-android", setOf("https://auth.kodera.test/"), LoopbackPolicy.REFUSE)
        })
    }

    @Test fun testTheRedirectIsTheLiteralScheme() {
        assertEquals("io.kodera.app:/oauth2redirect", SignInConfiguration.REDIRECT_URI)
    }

    @Test fun testOfflineAccessIsRequestedOnlyWhenTheBuildTurnsItOn() {
        assertEquals("off by default: the organisation realms do not offer it yet (I-2)", listOf("openid"), configuration().scopes)
        assertEquals(listOf("openid", "offline_access"),
            SignInConfiguration("kodera-android", setOf("https://auth.kodera.test"), LoopbackPolicy.REFUSE, offlineAccess = true).scopes)
        assertTrue(SignInConfiguration.offlineAccessSetting("true"))
        assertTrue(SignInConfiguration.offlineAccessSetting(" true "))
        for (value in listOf("", "false", "TRUE", "yes", "1", "on")) assertFalse(value, SignInConfiguration.offlineAccessSetting(value))
    }

    // sign-in and persistence

    @Test fun testSignInPersistsAndRestoresAcrossLaunches() {
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        assertNotNull(store.load())
        val relaunched = KoderaSignInService(configuration(), store, FakeBackend(failing(BackendFailure.UNAVAILABLE)))
        assertEquals(Session(issuer, "acme-sa"), relaunched.restore())
    }

    @Test fun testBackendFailuresMapToSafeOutcomesAndPersistNothing() {
        for ((failure, expected) in listOf(BackendFailure.CANCELLED to SignInFailure.CANCELLED,
                BackendFailure.UNAVAILABLE to SignInFailure.IDENTITY_UNAVAILABLE, BackendFailure.REFUSED to SignInFailure.REFUSED,
                BackendFailure.PROTOCOL_VIOLATION to SignInFailure.REFUSED)) {
            val store = InMemoryTokenStore()
            val service = KoderaSignInService(configuration(), store, FakeBackend(failing(failure)))
            assertEquals(expected, signInFailure { service.signIn(issuer) })
            assertNull(store.load())
            // The in-progress flag is released whatever the outcome.
            assertEquals(expected, signInFailure { service.signIn(issuer) })
        }
    }

    @Test fun testGrantForAnotherIssuerIsRefused() {
        val store = InMemoryTokenStore()
        val other = StoredGrant("https://auth.kodera.test/realms/other-org", "g")
        val backend = FakeBackend { other }
        val service = KoderaSignInService(configuration(), store, backend)
        assertEquals(SignInFailure.REFUSED, signInFailure { service.signIn(issuer) })
        assertNull(store.load())
        assertTrue("dropped, never revoked: only sign-out revokes", backend.revoked.isEmpty())
    }

    /** A session a new sign-in replaces is wiped before the browser opens, and not revoked. */
    @Test fun testASignInReplacingAGrantWipesItAndRevokesNothing() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        var storedAtAuthorize: ByteArray? = byteArrayOf(1)
        backend.authorizeResult = { storedAtAuthorize = store.load(); rotated }
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        assertNull("wiped before the browser opened", storedAtAuthorize)
        assertEnded(ended, SessionEndCause.REPLACED, "its derived data is told to go")
        assertTrue("revocation would sign the member out on every device", backend.revoked.isEmpty())
        assertTrue(String(checkNotNull(store.load())).contains("grant-2"))
        assertTrue(service.isSignedIn)
    }

    @Test fun testASignInReplacingAStoredCopyRevokesNothing() {
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        // A later process signs in without restoring first.
        val backend = FakeBackend { rotated }
        KoderaSignInService(configuration(), store, backend).signIn(issuer)
        assertTrue(backend.revoked.isEmpty())
        assertTrue(String(checkNotNull(store.load())).contains("grant-2"))
    }

    @Test fun testFailedSignInsRevokeNothing() {
        for (failure in BackendFailure.values()) {
            val backend = FakeBackend(failing(failure))
            signInFailure { KoderaSignInService(configuration(), InMemoryTokenStore(), backend).signIn(issuer) }
            assertTrue("$failure", backend.revoked.isEmpty())
        }
    }

    @Test fun testUnwritableStoreKeepsNothingAndRevokesNothing() {
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), FailingStore(), backend)
        assertEquals(SignInFailure.STORAGE, signInFailure { service.signIn(issuer) })
        assertTrue("dropped, never revoked: only sign-out revokes", backend.revoked.isEmpty())
        assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(false) })
    }

    @Test fun testSecondSignInWhileOneIsOpenIsInProgress() {
        val release = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        val backend = FakeBackend { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore(), backend)
        val first = thread(isDaemon = true) { service.signIn(issuer) }
        assertTrue("the fake was never reached", entered.await(5, TimeUnit.SECONDS))
        assertEquals(SignInFailure.IN_PROGRESS, signInFailure { service.signIn(issuer) })
        release.countDown(); first.join(2000); assertFalse("first is stuck", first.isAlive)
        assertEquals(1, backend.authorized.size)
    }

    @Test fun testCorruptOrNoLongerAdmittedStateIsWipedOnRestore() {
        for (garbage in listOf("not json", """{"version":2,"issuer":"$issuer","state":"x"}""",
                """{"version":1,"issuer":"$issuer"}""", """{"version":1,"issuer":"$issuer","state":"x","extra":1}""")) {
            val corrupt = InMemoryTokenStore(garbage.toByteArray())
            assertNull(KoderaSignInService(configuration(), corrupt, FakeBackend(failing(BackendFailure.UNAVAILABLE))).restore())
            assertNull(garbage, corrupt.load())
        }
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        val narrowed = KoderaSignInService(configuration(origins = setOf("https://other-auth.kodera.test")), store,
            FakeBackend(failing(BackendFailure.UNAVAILABLE)))
        assertNull(narrowed.restore())
        assertNull(store.load())
    }

    @Test fun testUnreadableStoreIsWipedOnRestore() {
        var wiped = false
        val store = object : TokenStore {
            override fun load(): ByteArray? = throw TokenStoreException("unsealable")
            override fun save(data: ByteArray) {}
            override fun wipe() { wiped = true }
        }
        assertNull(KoderaSignInService(configuration(), store, FakeBackend { grant }).restore())
        assertTrue(wiped)
    }

    // tokens

    @Test fun testFreshTokenPersistsARotatedGrant() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        backend.refreshResults += listOf({ FreshToken("access-2", rotated) }, { FreshToken("access-3", rotated) })
        assertEquals("access-2", service.accessToken(false).value)
        assertEquals("access-3", service.accessToken(true).value)
        assertEquals(listOf(false, true), backend.refreshes.map { it.second })
        assertEquals("the rotated grant is the one used next", rotated, backend.refreshes.last().first)
        assertTrue(String(checkNotNull(store.load())).contains("grant-2"))
        assertEquals("an unchanged grant is not written again", 2, store.saves)
    }

    @Test fun testRefusedRefreshSignsOutAndWipes() {
        for (failure in listOf(BackendFailure.REFUSED, BackendFailure.PROTOCOL_VIOLATION)) {
            val backend = FakeBackend { grant }
            val store = InMemoryTokenStore()
            val service = signedIn(backend, store)
            backend.refreshResults += failing(failure)
            assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(true) })
            assertNull(store.load())
            assertNull(service.restore())
            assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(false) })
            assertEquals("no grant left to refresh", 1, backend.refreshes.size)
            assertTrue("a refusal revokes nothing", backend.revoked.isEmpty())
        }
    }

    @Test fun testUnreachableProviderKeepsTheSession() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        backend.refreshResults += failing(BackendFailure.UNAVAILABLE)
        assertEquals(AccessTokenFailure.UNAVAILABLE, tokenFailure { service.accessToken(false) })
        assertNotNull(store.load())
        assertNotNull(service.restore())
    }

    @Test fun testConcurrentRefreshesRunOneAtATime() {
        val backend = FakeBackend { grant }
        val service = signedIn(backend)
        backend.refreshResults += listOf({ FreshToken("a", rotated) }, { FreshToken("b", rotated) })
        val tokens = CopyOnWriteArrayList<String>()
        val workers = List(2) { thread(isDaemon = true) { tokens += service.accessToken(true).value } }
        workers.forEach { it.join(2000); assertFalse("a worker is stuck", it.isAlive) }
        assertEquals(setOf("a", "b"), tokens.toSet())
        assertEquals(1, backend.maxInFlight.get())
        // The second refresh starts from the grant the first one rotated to.
        assertEquals(listOf(grant, rotated), backend.refreshes.map { it.first })
    }

    /** The refresh outlasts sign-out's wait: sign-out wipes anyway, and the late rotation is dropped. */
    @Test fun testSignOutDuringARefreshCannotResurrectTheGrant() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store, signOutWaitMillis = 50)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; FreshToken("late", rotated) }
        var outcome: AccessTokenFailure? = null
        val worker = thread(isDaemon = true) { outcome = tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        service.signOut()
        release.countDown(); worker.join(2000); assertFalse("worker is stuck", worker.isAlive)
        assertEquals(AccessTokenFailure.SIGNED_OUT, outcome)
        assertNull(store.load())
        assertNull(service.restore())
        assertEquals("one revocation, the sign-out's, of the grant held when it gave up waiting; the late rotation is dropped",
            listOf(grant), backend.revoked.toList())
    }

    /** A rotation that lands after a newer sign-in is dropped, not revoked. */
    @Test fun testARotationThatLandsAfterANewSignInIsDroppedNotRevoked() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store, signOutWaitMillis = 50)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; FreshToken("late", rotated) }
        var outcome: AccessTokenFailure? = null
        val worker = thread(isDaemon = true) { outcome = tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        service.signOut()
        val newer = StoredGrant(issuer, "grant-3")
        backend.authorizeResult = { newer }
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        release.countDown(); worker.join(2000); assertFalse("worker is stuck", worker.isAlive)
        assertEquals(AccessTokenFailure.SIGNED_OUT, outcome)
        assertEquals("only the grant sign-out ended", listOf(grant), backend.revoked.toList())
        assertTrue("the newer session is untouched", String(checkNotNull(store.load())).contains("grant-3"))
        assertTrue(service.isSignedIn)
    }

    @Test fun testSignOutWaitsForARefreshInFlightAndRevokesTheRotatedGrant() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; FreshToken("rotated-access", rotated) }
        var token: String? = null
        val refresh = thread(isDaemon = true) { token = service.accessToken(true).value }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        val signOut = thread(isDaemon = true) { service.signOut() }
        awaitTimedWait(signOut)
        assertTrue("sign-out waits for the refresh in flight", backend.revoked.isEmpty() && store.load() != null)
        release.countDown(); refresh.join(2000); assertFalse("refresh is stuck", refresh.isAlive); signOut.join(2000); assertFalse("signOut is stuck", signOut.isAlive)
        assertEquals("rotated-access", token)
        assertEquals("the token revoked is the one the refresh rotated to", listOf(rotated), backend.revoked.toList())
        assertNull(store.load())
        assertNull(service.restore())
    }

    /**
     * A sign-out still waiting for a refresh when the member signs in again: the sign-in revokes the old
     * grant itself, before the browser opens and after wiping it, when no new grant exists yet. The
     * sign-out, when it wakes, finds nothing of its own to end, so the old grant is revoked exactly once
     * and the new session is left alone.
     */
    @Test fun testASignInThatOvertakesAWaitingSignOutRevokesTheOldGrantFirst() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; FreshToken("late", grant) }
        val refresh = thread(isDaemon = true) { tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        val signOut = thread(isDaemon = true) { service.signOut() }
        awaitTimedWait(signOut)
        // While sign-out waits for the refresh, the member signs in again.
        val browsersAtRevoke = CopyOnWriteArrayList<Int>()
        val storedAtRevoke = CopyOnWriteArrayList<Boolean>()
        backend.onRevoke = { browsersAtRevoke += backend.authorized.size; storedAtRevoke += store.load() != null }
        backend.authorizeResult = { rotated }
        var again: Session? = null
        val signIn = thread(isDaemon = true) { again = service.signIn(issuer) }
        signIn.join(5000); assertFalse("the new sign-in is stuck", signIn.isAlive)
        assertEquals("the new sign-in did not proceed", Session(issuer, "acme-sa"), again)
        assertEquals("the old grant is revoked before the browser opens again", listOf(1), browsersAtRevoke.toList())
        assertEquals("wiped before it is revoked", listOf(false), storedAtRevoke.toList())
        release.countDown(); refresh.join(2000); assertFalse("refresh is stuck", refresh.isAlive); signOut.join(2000); assertFalse("signOut is stuck", signOut.isAlive)
        assertEquals("the old grant is revoked exactly once", listOf(grant), backend.revoked.toList())
        assertTrue("the new session survives the old sign-out", String(checkNotNull(store.load())).contains("grant-2"))
        assertTrue(service.isSignedIn)
    }

    /**
     * Keycloak detaches this client from every session the member has, so a sign-out's revocation that
     * lands after the next sign-in would end that one too. The sign-in waits for it before the browser opens.
     */
    @Test fun testASignInWaitsForTheSignOutsRevocationBeforeTheBrowserOpens() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val revoking = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.onRevoke = { revoking.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" } }
        val signOut = thread(isDaemon = true) { service.signOut() }
        assertTrue("the revocation never started", revoking.await(5, TimeUnit.SECONDS))
        backend.authorizeResult = { rotated }
        val signIn = thread(isDaemon = true) { service.signIn(issuer) }
        awaitTimedWait(signIn, "the sign-in never waited for the revocation in flight")
        assertEquals("the browser opened while the revocation was in flight", 1, backend.authorized.size)
        release.countDown()
        signIn.join(5000); assertFalse("the sign-in is stuck", signIn.isAlive)
        signOut.join(2000); assertFalse("signOut is stuck", signOut.isAlive)
        assertEquals(2, backend.authorized.size)
        assertEquals(listOf(grant), backend.revoked.toList())
        assertTrue("the new session is kept", String(checkNotNull(store.load())).contains("grant-2"))
    }

    /** Core's second 401 ends the session its token came from, never the one that replaced it. */
    @Test fun testEndSessionIsFencedByTheTokensSession() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        backend.refreshResults += { FreshToken("access-old", grant) }
        val old = service.accessToken(true)
        service.signOut()
        backend.authorizeResult = { rotated }
        service.signIn(issuer)
        service.endSession(old)
        assertTrue("a stale 401 leaves the new session", String(checkNotNull(store.load())).contains("grant-2"))
        assertEquals("only the explicit sign-out revoked", listOf(grant), backend.revoked.toList())
        backend.refreshResults += { FreshToken("access-new", rotated) }
        service.endSession(service.accessToken(true))
        assertNull("a current one ends it", store.load())
        assertEquals("wiped, not revoked", listOf(grant), backend.revoked.toList())
    }

    @Test fun testALateRefusalCannotWipeTheSessionThatReplacedIt() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store, signOutWaitMillis = 50)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; throw BackendException(BackendFailure.REFUSED) }
        var outcome: AccessTokenFailure? = null
        val worker = thread(isDaemon = true) { outcome = tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        // Signed out and back in while the old refresh is still with the provider.
        service.signOut()
        backend.authorizeResult = { rotated }
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        release.countDown(); worker.join(2000); assertFalse("worker is stuck", worker.isAlive)
        assertEquals(AccessTokenFailure.SIGNED_OUT, outcome)
        assertTrue("the new session survives the old refusal", String(checkNotNull(store.load())).contains("grant-2"))
        assertEquals(Session(issuer, "acme-sa"), service.restore())
    }

    // launch

    @Test fun testLaunchWithNothingStoredAsksNothing() {
        val backend = FakeBackend { grant }
        assertNull(KoderaSignInService(configuration(), InMemoryTokenStore(), backend).resume())
        assertTrue(backend.refreshes.isEmpty())
    }

    @Test fun testLaunchRefreshesSilentlyAndKeepsTheRotatedGrant() {
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        val backend = FakeBackend(failing(BackendFailure.UNAVAILABLE))
        backend.refreshResults += { FreshToken("access-2", rotated) }
        assertEquals(Session(issuer, "acme-sa"), KoderaSignInService(configuration(), store, backend).resume())
        assertEquals(listOf(grant to true), backend.refreshes.toList())
        assertTrue(String(checkNotNull(store.load())).contains("grant-2"))
    }

    @Test fun testLaunchWithARefusedRefreshPurgesAndReturnsToSignIn() {
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        val backend = FakeBackend(failing(BackendFailure.UNAVAILABLE))
        backend.refreshResults += failing(BackendFailure.REFUSED)
        val relaunched = KoderaSignInService(configuration(), store, backend)
        assertNull(relaunched.resume())
        assertNull(store.load())
        assertNull(relaunched.restore())
    }

    @Test fun testLaunchOfflineKeepsTheSession() {
        val store = InMemoryTokenStore()
        signedIn(FakeBackend { grant }, store)
        val backend = FakeBackend(failing(BackendFailure.UNAVAILABLE))
        backend.refreshResults += failing(BackendFailure.UNAVAILABLE)
        assertEquals(Session(issuer, "acme-sa"), KoderaSignInService(configuration(), store, backend).resume())
        assertNotNull(store.load())
    }

    // sign-out

    @Test fun testSignOutWipesThenRevokes() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        var storedAtRevoke: ByteArray? = byteArrayOf(1)
        var sessionAtRevoke: Session? = Session("x", "y")
        backend.onRevoke = { storedAtRevoke = store.load(); sessionAtRevoke = service.restore() }
        service.signOut()
        assertNull("the store is wiped before the provider is asked to revoke", storedAtRevoke)
        assertNull("the session is gone locally before the provider is asked to revoke", sessionAtRevoke)
        assertNull(store.load())
        assertEquals(listOf(grant), backend.revoked.toList())
        assertNull(service.restore())
        assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(false) })
        service.signOut()
        assertEquals("nothing left to revoke", 1, backend.revoked.size)
    }

    @Test fun testMeClientSignOutGoesThroughTheService() {
        val store = InMemoryTokenStore()
        val backend = FakeBackend { grant }
        val provider: AccessTokenProvider = signedIn(backend, store)
        backend.refreshResults += { FreshToken("access-2", grant) }
        provider.endSession(provider.accessToken(false))
        assertNull(store.load())
        assertTrue("Core's second 401 revokes nothing", backend.revoked.isEmpty())
    }

    @Test fun testSecretsAreNotInDiagnostics() {
        assertTrue(!grant.toString().contains("grant-1") && !FreshToken("access-9", grant).toString().contains("access-9"))
        assertFalse(AccessToken("access-9", 1).toString().contains("access-9"))
    }

    // the session-ended signal

    /** Registers a recording listener, as A2 registers the one that ends the Matrix session. */
    private fun listening(service: KoderaSignInService, store: TokenStore? = null, backend: FakeBackend? = null): EndedLog =
        EndedLog(store, backend).also { log -> service.addSessionEndedListener { log.record(it) } }

    /** The one signal the step before told, with [cause] (and [session], when given). */
    private fun assertEnded(ended: EndedLog, cause: SessionEndCause, what: String, session: Long? = null): SessionEnded {
        val events = ended.sinceLast()
        assertEquals("$what: ${events.size} signals, not one: $events", 1, events.size)
        val event = events.single()
        assertEquals("$what: the wrong cause", cause, event.cause)
        if (session != null) assertEquals("$what: the wrong session", session, event.session)
        return event
    }

    private fun assertSilent(ended: EndedLog, what: String) {
        val events = ended.sinceLast()
        assertEquals("$what: ${events.size} signals", emptyList<SessionEnded>(), events)
    }

    /** The session the service holds now, as its tokens carry it; the refresh hands [current] back unrotated. */
    private fun heldSession(service: KoderaSignInService, backend: FakeBackend, current: StoredGrant = grant): Long {
        backend.refreshResults += { FreshToken("held", current) }
        return service.accessToken(false).session
    }

    /** The explicit sign-out ends the session once, with its tokens' session; a second ends nothing. */
    @Test fun testTheSignalFiresOnceForAnExplicitSignOut() {
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore(), backend)
        val ended = listening(service)
        service.signIn(issuer)
        assertSilent(ended, "a sign-in with nothing held reported an ended session")
        val held = heldSession(service, backend)
        service.signOut()
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the sign-out", held)
        service.signOut()
        assertSilent(ended, "a sign-out with nothing signed in reported an ended session")
    }

    /** A refused refresh ends the session once; a refresh asked for afterwards finds nothing to end. */
    @Test fun testTheSignalFiresOnceForARefusedRefresh() {
        val backend = FakeBackend { grant }
        val service = signedIn(backend)
        val ended = listening(service)
        val held = heldSession(service, backend)
        backend.refreshResults += failing(BackendFailure.REFUSED)
        assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(true) })
        assertEnded(ended, SessionEndCause.REFRESH_REFUSED, "the refused refresh", held)
        assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(true) })
        assertSilent(ended, "a refresh with nothing signed in reported an ended session")
    }

    /** Core's second 401 ends the session that served the token, once; the same refusal again ends nothing. */
    @Test fun testTheSignalFiresOnceForCoresSecondRefusal() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        backend.refreshResults += { FreshToken("access", rotated) }
        val token = service.accessToken(true)
        assertSilent(ended, "a refresh that rotated the grant reported an ended session")
        service.endSession(token)
        assertEnded(ended, SessionEndCause.ENDED_BY_SERVER, "Core's second 401", token.session)
        assertNull(store.load())
        service.endSession(token)
        assertSilent(ended, "a 401 for a session already ended reported it again")
    }

    /** Two sessions in a row in one process are told apart: each signal carries its own session's identity. */
    @Test fun testTwoSessionsInARowReportDifferentIdentities() {
        val backend = FakeBackend { grant }
        val service = signedIn(backend)
        val ended = listening(service)
        val first = heldSession(service, backend)
        service.signOut()
        val firstEnd = assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the first session's sign-out", first)

        backend.authorizeResult = { rotated }
        service.signIn(issuer)
        val second = heldSession(service, backend, rotated)
        assertNotEquals("two sessions in a row carried the same identity", first, second)
        service.endSession(AccessToken("refused", second))
        val secondEnd = assertEnded(ended, SessionEndCause.ENDED_BY_SERVER, "the second session's 401", second)
        assertNotEquals("two ended sessions were reported as one", firstEnd.session, secondEnd.session)
    }

    /**
     * A sign-in that replaces a held session ends it once, as replaced, with the old session's identity,
     * and before the new one is held: when the listener is told, the old grant is wiped and the sign-in has
     * not reached the browser. The same holds for a stored copy a previous process left.
     */
    @Test fun testAReplacedSessionIsReportedWithItsIdentityBeforeTheNewOneIsHeld() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val ended = listening(service, store, backend)
        val old = heldSession(service, backend)
        backend.authorizeResult = { rotated }
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        assertEnded(ended, SessionEndCause.REPLACED, "the sign-in that replaced a held session", old)
        assertEquals("the replaced session was reported once the new one was stored", listOf(false), ended.storedAt.toList())
        assertEquals("the replaced session was reported after the browser opened", listOf(1), ended.browsersAt.toList())
        val new = heldSession(service, backend, rotated)
        assertNotEquals("the new session carries the replaced session's identity", old, new)

        // The next process signs in without restoring first: the stored copy is a session too.
        val nextBackend = FakeBackend { StoredGrant(issuer, "grant-3") }
        val relaunched = KoderaSignInService(configuration(), store, nextBackend)
        val endedAfterRelaunch = listening(relaunched, store, nextBackend)
        relaunched.signIn(issuer)
        assertEnded(endedAfterRelaunch, SessionEndCause.REPLACED, "the sign-in that replaced a stored session")
        assertEquals("the replaced stored session was reported once the new one was stored", listOf(false),
            endedAfterRelaunch.storedAt.toList())
        assertEquals("the replaced stored session was reported after the browser opened", listOf(0),
            endedAfterRelaunch.browsersAt.toList())
        assertSilent(ended, "one service's listener heard another service's session end")
    }

    /** A rotated grant the store cannot keep ends the session, as other: the old grant is spent. */
    @Test fun testTheSignalFiresOnceForARotatedGrantTheStoreCannotKeep() {
        val backend = FakeBackend { grant }
        val store = RefusesRotationStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        backend.refreshResults += { FreshToken("access", rotated) }
        assertEquals(AccessTokenFailure.SIGNED_OUT, tokenFailure { service.accessToken(true) })
        assertEnded(ended, SessionEndCause.OTHER, "the dropped rotation")
        assertNull(store.load())
    }

    /** A stored copy restore cannot use is wiped and ends once; the session signed in next has another identity. */
    @Test fun testTheSignalFiresOnceForAStoredCopyThatCannotBeRestored() {
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore("garbage".toByteArray()), backend)
        val ended = listening(service)
        assertNull(service.restore())
        val unusable = assertEnded(ended, SessionEndCause.UNUSABLE_STORED_COPY, "the unusable stored copy")
        assertNull(service.restore())
        assertSilent(ended, "a restore with nothing stored reported an ended session")
        service.signIn(issuer)
        assertNotEquals("the next session carries the unusable copy's identity", unusable.session, heldSession(service, backend))

        val unsealable = object : TokenStore {
            override fun load(): ByteArray? = throw TokenStoreException("unsealable")
            override fun save(data: ByteArray) {}
            override fun wipe() {}
        }
        val sealed = KoderaSignInService(configuration(), unsealable, backend)
        val endedSealed = listening(sealed)
        assertNull(sealed.restore())
        assertEnded(endedSealed, SessionEndCause.UNUSABLE_STORED_COPY, "the stored copy that cannot be unsealed")
    }

    /**
     * A wipe that fails still ends the session, and says so once: the file it left can never be read, and
     * the retries that follow (the next restore, the next sign-in) wipe it again but end nothing new.
     */
    @Test fun testAFailedWipeEndsTheSessionOnceAndItsRetriesEndNothing() {
        val backend = FakeBackend { grant }
        val store = UndeletableSealedStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        service.signOut()
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the sign-out whose wipe failed")
        assertNull("a session that ended was restored", service.restore())
        assertSilent(ended, "retrying the failed wipe by restoring reported the session again")
        backend.authorizeResult = { rotated }
        assertEquals(Session(issuer, "acme-sa"), service.signIn(issuer))
        assertSilent(ended, "the sign-in over the leftover copy reported the session again")
        service.signOut()
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the next session's sign-out")
    }

    @Test fun testRestoreCannotReadmitTheSameSessionAfterBothWipeOperationsFail() {
        SealedWipeFixture().use { f ->
            f.end(failKey = true, failFile = true)
            f.assertOriginalStillReadable()
            val endedOwner = f.events.single()
            val restored = f.service.restore()
            f.assertOriginalStillReadable()
            assertEquals("restore emitted another end", listOf(endedOwner), f.events)
            assertEquals("restore authorized again", 1, f.backend.authorized.size)
            assertTrue("restore refreshed", f.backend.refreshes.isEmpty())
            if (restored == Session(issuer, "acme-sa") && f.service.isSignedIn) {
                throw AssertionError("EndedSessionRestoredAfterFailedWipe")
            }
            assertNull("the ended owner was returned", restored)
            assertFalse("the ended owner was re-admitted", f.service.isSignedIn)
            assertEquals("restore skipped cleanup retry", 2, f.keys.destroyAttempts)
            assertEquals("restore skipped file cleanup", 2, f.file.deleteAttempts)
            repeat(2) { retry ->
                assertNull("a repeated cleanup re-admitted the owner", f.service.restore())
                assertFalse(f.service.isSignedIn)
                f.assertOriginalStillReadable()
                assertEquals("a cleanup retry emitted another end", listOf(endedOwner), f.events)
                assertEquals(3 + retry, f.keys.destroyAttempts)
                assertEquals(3 + retry, f.file.deleteAttempts)
            }
        }
    }

    @Test fun testResumeCannotRefreshTheSameSessionAfterBothWipeOperationsFail() {
        SealedWipeFixture().use { f ->
            f.end(failKey = true, failFile = true)
            f.assertOriginalStillReadable()
            val endedOwner = f.events.single()
            f.backend.refreshResults += { FreshToken("synthetic-resume", grant) }
            val resumed = f.service.resume()
            f.assertOriginalStillReadable()
            assertEquals("resume emitted another end", listOf(endedOwner), f.events)
            assertEquals("resume authorized again", 1, f.backend.authorized.size)
            if (resumed == Session(issuer, "acme-sa") && f.service.isSignedIn &&
                f.backend.refreshes.toList() == listOf(grant to true)) {
                throw AssertionError("EndedSessionRefreshedByResumeAfterFailedWipe")
            }
            assertNull("resume returned the ended owner", resumed)
            assertFalse("resume re-admitted the ended owner", f.service.isSignedIn)
            assertTrue("resume refreshed the ended owner", f.backend.refreshes.isEmpty())
            assertEquals("resume skipped cleanup retry", 2, f.keys.destroyAttempts)
            assertEquals("resume skipped file cleanup", 2, f.file.deleteAttempts)
        }
    }

    @Test fun testSuccessfulSealedWipeRemovesTheCopyAndInvalidatesRetainedCiphertext() {
        SealedWipeFixture().use { f ->
            f.end(failKey = false, failFile = false)
            assertNull(f.keys.existing())
            assertFalse(f.file.exists())
            assertNull(EncryptedFileTokenStore(f.file, f.keys).load())
            assertNull(f.service.restore())
            assertNull(f.service.resume())
            assertEquals(1, f.events.size)
            assertEquals(1, f.keys.destroyAttempts)
            assertEquals(1, f.file.deleteAttempts)
            assertTrue(f.backend.refreshes.isEmpty())
            f.keys.getOrCreate()
            f.file.writeBytes(f.originalSealed)
            try {
                EncryptedFileTokenStore(f.file, f.keys).load()
                fail("a replacement key opened the retired ciphertext")
            } catch (_: TokenStoreException) { }
        }
    }

    @Test fun testKeyDestructionFailureAloneStillRemovesTheCurrentStoredCopy() {
        SealedWipeFixture().use { f ->
            f.end(failKey = true, failFile = false)
            assertTrue("the key failure was not exercised", f.keys.existing() === f.originalKey)
            assertFalse("the current file was not removed", f.file.exists())
            assertNull(EncryptedFileTokenStore(f.file, f.keys).load())
            assertNull(f.service.restore())
            assertNull(f.service.resume())
            assertEquals(1, f.events.size)
            assertEquals(1, f.keys.destroyAttempts)
            assertEquals(1, f.file.deleteAttempts)
            assertTrue(f.backend.refreshes.isEmpty())
            // File removal is not proof of cryptographic erasure: the old key is still held.
            assertTrue(f.keys.existing() === f.originalKey)
        }
    }

    @Test fun testFileDeletionFailureAloneInvalidatesTheCopyAndRetriesWithoutAnotherEnd() {
        SealedWipeFixture().use { f ->
            f.end(failKey = false, failFile = true)
            assertNull("the key was not destroyed", f.keys.existing())
            assertTrue("the refused file deletion was not exercised", f.file.isFile)
            assertTrue(f.originalSealed.contentEquals(f.file.readBytes()))
            try {
                EncryptedFileTokenStore(f.file, f.keys).load()
                fail("the retained ciphertext still has a usable key")
            } catch (_: TokenStoreException) { }
            repeat(3) { retry ->
                val restored = if (retry == 1) f.service.resume() else f.service.restore()
                assertNull(restored)
                assertFalse(f.service.isSignedIn)
                assertEquals("cleanup emitted a duplicate end", 1, f.events.size)
                assertEquals("key cleanup was not retried", 2 + retry, f.keys.destroyAttempts)
                assertEquals("file cleanup was not retried", 2 + retry, f.file.deleteAttempts)
            }
            assertTrue(f.backend.refreshes.isEmpty())
            assertEquals("cleanup revoked again", listOf(grant), f.backend.revoked.toList())
        }
    }

    @Test fun testLaterCleanupSuccessStillReturnsNullAndDoesNotReportAnotherEnd() {
        SealedWipeFixture().use { f ->
            f.end(failKey = false, failFile = true)
            f.file.refuseDelete = false
            assertNull("successful cleanup restored an ended owner", f.service.restore())
            assertFalse(f.service.isSignedIn)
            assertNull(f.keys.existing())
            assertFalse(f.file.exists())
            assertEquals("cleanup was not retried", 2, f.keys.destroyAttempts)
            assertEquals(2, f.file.deleteAttempts)
            assertEquals(1, f.events.size)
            assertNull(f.service.restore())
            assertNull(f.service.resume())
            assertEquals("empty restore retried completed cleanup", 2, f.keys.destroyAttempts)
            assertEquals(1, f.events.size)
            assertTrue(f.backend.refreshes.isEmpty())
        }
    }

    @Test fun testUntouchedSealedSessionCanStillRestoreAndResumeWithoutInteractiveSignIn() {
        SealedWipeFixture().use { f ->
            val backend = FakeBackend { fail("untouched restore authorized interactively"); grant }
            val restored = KoderaSignInService(configuration(), EncryptedFileTokenStore(f.file, f.keys), backend)
            val ended = listening(restored)
            assertEquals(Session(issuer, "acme-sa"), restored.restore())
            assertTrue(restored.isSignedIn)
            assertTrue(backend.authorized.isEmpty())
            assertTrue(backend.refreshes.isEmpty())
            backend.refreshResults += { FreshToken("synthetic-restored", grant) }
            assertEquals(Session(issuer, "acme-sa"), restored.resume())
            assertEquals(listOf(grant to true), backend.refreshes.toList())
            assertTrue(backend.authorized.isEmpty())
            assertEquals(0, f.keys.destroyAttempts)
            assertEquals(0, f.file.deleteAttempts)
            assertSilent(ended, "normal cold restore ended a valid owner")
        }
    }

    @Test fun testNewInteractiveSignInAfterFailedWipeClearsTheFenceAndRejectsTheOldTokenEnd() {
        SealedWipeFixture().use { f ->
            f.backend.refreshResults += { FreshToken("synthetic-old", grant) }
            val old = f.service.accessToken(true)
            f.backend.refreshes.clear()
            f.end(failKey = true, failFile = true)
            f.assertOriginalStillReadable()
            f.backend.authorizeResult = { rotated }
            assertEquals(Session(issuer, "acme-sa"), f.service.signIn(issuer))
            assertTrue(f.service.isSignedIn)
            assertEquals("replacement did not retry cleanup", 2, f.keys.destroyAttempts)
            assertEquals(2, f.file.deleteAttempts)
            assertEquals("retry reported the old owner twice", 1, f.events.size)
            assertEquals(2, f.backend.authorized.size)
            assertEquals(Session(issuer, "acme-sa"), f.service.restore())
            f.backend.refreshResults += { FreshToken("synthetic-new", rotated) }
            val fresh = f.service.accessToken(true)
            assertNotEquals("replacement reused the ended generation", old.session, fresh.session)
            assertTrue("cleanup did not advance beyond the ended generation", fresh.session > old.session + 1)
            val newSealed = f.file.readBytes()
            f.service.endSession(old)
            assertTrue("old-token refusal ended the replacement", f.service.isSignedIn)
            assertTrue("old-token refusal changed replacement storage", newSealed.contentEquals(f.file.readBytes()))
            assertEquals("old-token refusal attempted key deletion", 2, f.keys.destroyAttempts)
            assertEquals(2, f.file.deleteAttempts)
            assertEquals(1, f.events.size)
            assertEquals("cleanup or stale refusal revoked again", listOf(grant), f.backend.revoked.toList())
        }
    }

    /**
     * Nothing held, nothing reported: a sign-out, a restore and a session end before any sign-in, and a
     * sign-in whose own grant the store refused.
     */
    @Test fun testTheSignalIsSilentWhenNoSessionEnded() {
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore(), backend)
        val ended = listening(service)
        service.signOut()
        assertNull(service.restore())
        // The generation now: that sign-out's wipe moved it to 1, so this end passes the fence and wipes
        // with nothing held.
        service.endSession(AccessToken("refused", 1))
        assertSilent(ended, "a call that ended nothing reported an ended session")

        val refusing = KoderaSignInService(configuration(), RefusesSaveStore(), backend)
        val refusedEnds = listening(refusing)
        assertEquals(SignInFailure.STORAGE, signInFailure { refusing.signIn(issuer) })
        assertSilent(refusedEnds, "a sign-in that never held a session reported one ended")
    }

    /** The fence: Core's second 401 for a token an earlier session served is a no-op, and reports nothing. */
    @Test fun testTheSignalIsSilentForAStaleSecondRefusal() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        backend.refreshResults += { FreshToken("access-old", grant) }
        val stale = service.accessToken(true)
        service.signOut()
        backend.authorizeResult = { rotated }
        service.signIn(issuer)
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the sign-out", stale.session)
        service.endSession(stale)
        assertSilent(ended, "a stale 401 the fence turned away reported an ended session")
        assertTrue("the stale 401 wiped the session that replaced its own", String(checkNotNull(store.load())).contains("grant-2"))
    }

    /** The fence: a refusal that lands after a sign-out and a new sign-in is a no-op, and reports nothing. */
    @Test fun testTheSignalIsSilentForALateRefusal() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store, signOutWaitMillis = 50)
        val ended = listening(service)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; throw BackendException(BackendFailure.REFUSED) }
        val worker = thread(isDaemon = true) { tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        service.signOut()
        backend.authorizeResult = { rotated }
        service.signIn(issuer)
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the sign-out")
        release.countDown(); worker.join(2000); assertFalse("worker is stuck", worker.isAlive)
        assertSilent(ended, "a late refusal the fence turned away reported an ended session")
        assertTrue("the late refusal wiped the session that replaced its own", String(checkNotNull(store.load())).contains("grant-2"))
    }

    /**
     * The fence: a sign-out that a new sign-in overtook ends nothing when it wakes. The sign-in ended the
     * session, once, and as the member's sign-out, since it revoked the grant that sign-out was to end.
     */
    @Test fun testTheSignalIsSilentForAnOvertakenSignOut() {
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = signedIn(backend, store)
        val ended = listening(service)
        val inside = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        backend.refreshResults += { inside.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "test gate never released" }; FreshToken("late", grant) }
        val refresh = thread(isDaemon = true) { tokenFailure { service.accessToken(true) } }
        assertTrue("the fake was never reached", inside.await(5, TimeUnit.SECONDS))
        val signOut = thread(isDaemon = true) { service.signOut() }
        awaitTimedWait(signOut)
        backend.authorizeResult = { rotated }
        val signIn = thread(isDaemon = true) { service.signIn(issuer) }
        signIn.join(5000); assertFalse("the new sign-in is stuck", signIn.isAlive)
        assertEnded(ended, SessionEndCause.EXPLICIT_SIGN_OUT, "the sign-in that took the sign-out over")
        release.countDown(); refresh.join(2000); assertFalse("refresh is stuck", refresh.isAlive)
        signOut.join(2000); assertFalse("signOut is stuck", signOut.isAlive)
        assertSilent(ended, "the overtaken sign-out reported the session a second time")
        assertTrue("the overtaken sign-out wiped the new session", String(checkNotNull(store.load())).contains("grant-2"))
    }
    @Test fun acceptedReceiptIsStableAcrossRestoreAndRotationAndRejectsForeignService() {
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore(), backend)
        val owner = service.signInAccepted(issuer)
        org.junit.Assert.assertSame(owner, service.restoreAccepted())
        backend.refreshResults += { FreshToken("synthetic-rotated", rotated) }
        val token = service.accessTokenFor(owner, true)
        assertEquals(owner.generation, token.session)
        org.junit.Assert.assertSame(owner, service.restoreAccepted())
        assertFalse(owner.isRetired)
        val other = KoderaSignInService(configuration(), InMemoryTokenStore(), FakeBackend { grant })
        val foreign = other.signInAccepted(issuer)
        assertEquals(owner.session, foreign.session)
        assertEquals(owner.generation, foreign.generation)
        try { service.accessTokenFor(foreign, false); fail("foreign receipt accepted") }
        catch (error: AccessTokenException) { assertEquals(AccessTokenFailure.SIGNED_OUT, error.failure) }
        assertFalse(service.admitSend(owner, AccessToken("synthetic-foreign-generation", token.session + 1)))
        service.endSessionFor(foreign, token)
        assertFalse(owner.isRetired)
        backend.authorizeResult = { grant }
        val replacement = service.signInAccepted(issuer)
        assertTrue(owner.isRetired)
        org.junit.Assert.assertNotSame(owner, replacement)
        owner.signOut()
        assertFalse("retired owner sign-out ended its replacement", replacement.isRetired)
        assertTrue(backend.revoked.isEmpty())
    }

    @Test fun receiptRetiresBeforeFailedWipeAndUnderLockListenerWithoutServiceReentry() {
        val inner = InMemoryTokenStore()
        var owner: AcceptedOwner? = null
        var retiredAtWipe = false
        val store = object : TokenStore {
            override fun load() = inner.load()
            override fun save(data: ByteArray) = inner.save(data)
            override fun wipe() {
                retiredAtWipe = owner?.isRetired == true
                throw TokenStoreException("synthetic failed wipe")
            }
        }
        val service = KoderaSignInService(configuration(), store, FakeBackend { grant })
        owner = service.signInAccepted(issuer)
        val events = mutableListOf<SessionEnded>()
        var listenerThread: Thread? = null
        service.addSessionEndedListener { event ->
            listenerThread = Thread.currentThread()
            assertTrue("receipt not retired before listener", checkNotNull(event.owner).isRetired)
            events += event
        }
        service.signOut()
        assertTrue(retiredAtWipe)
        org.junit.Assert.assertSame(Thread.currentThread(), listenerThread)
        org.junit.Assert.assertSame(owner, events.single().owner)
        assertNull(service.captureAcceptedOwner())
        assertNull(service.restoreAccepted())
        assertEquals("failed-wipe cleanup issued another end", 1, events.size)
        val failed = KoderaSignInService(configuration(), RefusesSaveStore(), FakeBackend { grant })
        try { failed.signInAccepted(issuer); fail("failed persistence accepted") }
        catch (error: SignInException) { assertEquals(SignInFailure.STORAGE, error.failure) }
        assertNull(failed.captureAcceptedOwner())
        val malformed = InMemoryTokenStore().apply { save("not a stored envelope".toByteArray()) }
        val neverAccepted = KoderaSignInService(configuration(), malformed, FakeBackend { grant })
        val rejected = mutableListOf<SessionEnded>()
        neverAccepted.addSessionEndedListener { rejected += it }
        assertNull(neverAccepted.restoreAccepted())
        assertNull(rejected.single().owner)
    }

    /** Both sides of R use the real refresh serialization and keep the replacement current. */
    @Test fun refreshAdmissionRejectsRetiredOwnerBeforeGrantSelection() = refreshAdmissionRace(false)
    @Test fun admittedRefreshUsesOnlyCapturedOldGrantAndCannotPersistIntoReplacement() = refreshAdmissionRace(true)

    private fun refreshAdmissionRace(afterAdmission: Boolean) {
        val reached = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val once = java.util.concurrent.atomic.AtomicBoolean()
        val gate = { if (once.compareAndSet(false, true)) {
            reached.countDown(); check(release.await(5, TimeUnit.SECONDS)) { "R gate not released" }
        }; Unit }
        val backend = FakeBackend { grant }
        val store = InMemoryTokenStore()
        val service = KoderaSignInService(configuration(), store, backend,
            if (afterAdmission) RefreshAdmissionGates(after = gate) else RefreshAdmissionGates(before = gate))
        val old = service.signInAccepted(issuer)
        backend.refreshResults += { FreshToken("synthetic-old", grant) }
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<AccessTokenFailure?> {
                try { service.accessTokenFor(old, true); null } catch (error: AccessTokenException) { error.failure }
            }
            assertTrue("R gate not reached", reached.await(5, TimeUnit.SECONDS))
            backend.authorizeResult = { rotated }
            val replacement = service.signInAccepted(issuer)
            release.countDown()
            assertEquals(AccessTokenFailure.SIGNED_OUT, result.get(5, TimeUnit.SECONDS))
            assertEquals(if (afterAdmission) listOf(grant to true) else emptyList<Pair<StoredGrant, Boolean>>(), backend.refreshes.toList())
            org.junit.Assert.assertSame(replacement, service.restoreAccepted())
            assertTrue(String(checkNotNull(store.load())).contains("grant-2"))
            backend.refreshResults.clear()
            backend.refreshResults += { FreshToken("synthetic-current", rotated) }
            assertEquals(replacement.generation, service.accessTokenFor(replacement, false).session)
        } finally {
            release.countDown(); worker.shutdownNow()
            assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test fun legacyResumeCannotRefreshOrReturnAReplacementOwner() {
        val reached = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val backend = FakeBackend { grant }
        val service = KoderaSignInService(configuration(), InMemoryTokenStore(), backend,
            RefreshAdmissionGates(before = { reached.countDown(); check(release.await(5, TimeUnit.SECONDS)) }))
        service.signInAccepted(issuer)
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<Session?> { service.resume() }
            assertTrue(reached.await(5, TimeUnit.SECONDS))
            backend.authorizeResult = { rotated }
            val replacement = service.signInAccepted(issuer)
            release.countDown()
            assertNull(result.get(5, TimeUnit.SECONDS))
            assertTrue("legacy resume borrowed G2's grant", backend.refreshes.isEmpty())
            org.junit.Assert.assertSame(replacement, service.captureAcceptedOwner())
        } finally {
            release.countDown(); worker.shutdownNow(); assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

}

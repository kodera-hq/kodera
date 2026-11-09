package io.kodera.android.client

import com.google.gson.JsonObject
import io.kodera.android.domain.AdmittedIssuer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Internal, outside-service-lock race gates. Production callers cannot install them. */
internal class RefreshAdmissionGates(val before: () -> Unit = {}, val after: () -> Unit = {})

/**
 * Revocation policy: only an explicit [signOut] calls the provider's revocation endpoint, or the
 * sign-in that overtakes one still waiting (see [wipeHeld]). Keycloak revokes a refresh or offline token
 * by detaching this client from every session the member has, on every device (and, for an offline
 * token, deleting the member's offline tokens for it); so any other revocation would sign the member out
 * elsewhere. Every other end (a replaced grant, a failed sign-in, a late rotation, Core's second 401, a
 * refused refresh) wipes locally and calls nothing.
 *
 * The one owner of the signed-in state: it admits the issuer, drives the backend, persists the grant
 * and wipes it when the provider refuses it. Thread-safe; every method but [isSignedIn] blocks. The
 * app holds one per process.
 *
 * Each session it ends is reported once, at the wipe, to the [addSessionEndedListener] listeners.
 */
class KoderaSignInService private constructor(
    private val configuration: SignInConfiguration,
    private val store: TokenStore,
    private val backend: AuthorizationBackend,
    /** How long [signOut] waits for a refresh in flight before it wipes anyway. */
    private val signOutWaitMillis: Long,
    private val admissions: RefreshAdmissionGates,
) : SignInService {
    constructor(configuration: SignInConfiguration, store: TokenStore, backend: AuthorizationBackend,
        signOutWaitMillis: Long = SIGN_OUT_WAIT_MILLIS) :
        this(configuration, store, backend, signOutWaitMillis, RefreshAdmissionGates())

    internal constructor(configuration: SignInConfiguration, store: TokenStore, backend: AuthorizationBackend,
        admissions: RefreshAdmissionGates) : this(configuration, store, backend, SIGN_OUT_WAIT_MILLIS, admissions)

    private var acceptedOwner: AcceptedOwner? = null
    private val lock = Any()
    @Volatile private var grant: StoredGrant? = null
    private var admitted: AdmittedIssuer? = null
    /** Bumped on every sign-in and sign-out, so a refresh that finishes afterwards cannot resurrect state. */
    private var generation = 0L
    private var signingIn = false
    /**
     * A wipe failed in this process: the stored copy left behind belongs to a session whose end was
     * reported already, so wiping it again ends nothing new.
     */
    private var leftover = false
    private val ended = CopyOnWriteArrayList<(SessionEnded) -> Unit>()
    // Refreshes run one at a time: Keycloak rotates refresh tokens, so two concurrent refreshes from
    // the same grant would see the second refused and sign the member out.
    private val refreshing = ReentrantLock(true)
    /**
     * The generation the last sign-out set out to end. While it is still the current generation, that
     * sign-out is waiting for a refresh in flight: whichever way a sign-out ends, the generation moves on.
     */
    private var signOutTarget: Long? = null
    /**
     * Open while the last revocation sent is in flight. A sign-in waits on it before the browser opens:
     * Keycloak detaches this client from every session the member has, so a revocation that landed after
     * the new sign-in would end that one too.
     */
    private var revocation: CountDownLatch? = null

    /** A revocation decided under [lock], sent once no lock is held. */
    private inner class Revoking(private val grant: StoredGrant, private val issuer: AdmittedIssuer) {
        private val done = CountDownLatch(1).also { revocation = it }

        fun send() {
            try { backend.revoke(grant, issuer, configuration) } catch (_: RuntimeException) { } finally { done.countDown() }
        }
    }

    override val isSignedIn: Boolean get() = grant != null

    /**
     * [listener] is told once for each session this service ends, with the session's identity
     * ([SessionEnded.session], the `session` its access tokens carried) and the cause:
     * - [SessionEndCause.EXPLICIT_SIGN_OUT]: [signOut], or a sign-in that took over a sign-out still
     *   waiting for a refresh;
     * - [SessionEndCause.REFRESH_REFUSED]: the provider refused a refresh;
     * - [SessionEndCause.ENDED_BY_SERVER]: Core's second 401 ([endSession]);
     * - [SessionEndCause.REPLACED]: a sign-in replaced a held session (in memory, or a stored copy);
     * - [SessionEndCause.UNUSABLE_STORED_COPY]: [restore] found a stored copy it cannot use;
     * - [SessionEndCause.OTHER]: a rotated grant the store could not keep.
     *
     * A call the generation fence turns away (a late refusal, a stale 401, a sign-out a new sign-in
     * overtook) ends nothing and tells no one. So does a wipe with nothing held: a sign-out with nothing
     * signed in, a sign-in whose own grant the store refused, and wiping again a copy whose earlier wipe
     * failed in this process (by [restore] or by a sign-in).
     *
     * It runs at the wipe, on the thread that wiped, while that thread holds the service's lock: once the
     * session's tokens are gone from memory and the store's wipe has been tried, and before anything else
     * can run on the service. A replaced session is therefore reported before the sign-in that replaced
     * it opens the browser. It must not block and must not call the service; work it starts runs
     * elsewhere (the app posts to the main thread). An exception it throws is dropped. Listeners are
     * never removed; the service lives as long as the process.
     */
    override fun addSessionEndedListener(listener: (SessionEnded) -> Unit) { ended += listener }

    override fun signIn(issuer: String): Session = signInAccepted(issuer).session

    override fun captureAcceptedOwner(): AcceptedOwner? = synchronized(lock) { acceptedOwner }

    override fun signInAccepted(issuer: String): AcceptedOwner {
        val admitted = configuration.admit(issuer)
        synchronized(lock) {
            if (signingIn) throw SignInException(SignInFailure.IN_PROGRESS)
            signingIn = true
        }
        return try {
            wipeHeld()?.send()
            awaitRevocation()
            val grant = try { backend.authorize(admitted, configuration) } catch (error: BackendException) {
                throw SignInException(when (error.failure) {
                    BackendFailure.CANCELLED -> SignInFailure.CANCELLED
                    BackendFailure.UNAVAILABLE -> SignInFailure.IDENTITY_UNAVAILABLE
                    BackendFailure.REFUSED, BackendFailure.PROTOCOL_VIOLATION -> SignInFailure.REFUSED
                })
            }
            // Dropped, never revoked: see the revocation policy above.
            if (grant.issuer != admitted.issuer) throw SignInException(SignInFailure.REFUSED)
            val accepted = synchronized(lock) {
                generation++
                try {
                    persist(grant)
                    this.grant = grant
                    this.admitted = admitted
                    leftover = false // the stored copy is now this session's
                    AcceptedOwner(Session(admitted.issuer, admitted.realm), this, generation).also { acceptedOwner = it }
                } catch (_: TokenStoreException) {
                    // Nothing was held, so no session ends here.
                    wipeLocal(SessionEndCause.OTHER)
                    null
                }
            }
            accepted ?: throw SignInException(SignInFailure.STORAGE)
        } finally {
            synchronized(lock) { signingIn = false }
        }
    }

    /**
     * A session still held when a sign-in starts (in memory, or a stored copy) is wiped before the
     * browser opens, so features holding data derived from it hear that it ended. It is not revoked (see
     * the revocation policy above), with one exception, which this returns: the grant a sign-out still
     * waiting for a refresh was to end. The sign-in revokes that one before the browser opens, when no new
     * grant exists yet, so the member's sign-out is not lost to the sign-in that overtook it; the
     * generation moves on, so the sign-out then finds nothing of its own to end. That grant ends as the
     * member's sign-out; any other ends as replaced.
     */
    private fun wipeHeld(): Revoking? = synchronized(lock) {
        val stored = try { store.load() != null } catch (_: TokenStoreException) { true }
        if (grant == null && !stored) return@synchronized null
        val overtaken = if (signOutTarget == generation) grant?.let { g -> admitted?.let { Revoking(g, it) } } else null
        wipeLocal(if (overtaken != null) SessionEndCause.EXPLICIT_SIGN_OUT else SessionEndCause.REPLACED,
            endingStoredCopy = true)
        overtaken
    }

    /** Waits, at most [REVOCATION_WAIT_MILLIS], for the last revocation sent: see [revocation]. */
    private fun awaitRevocation() {
        val pending = synchronized(lock) { revocation } ?: return
        try { pending.await(REVOCATION_WAIT_MILLIS, TimeUnit.MILLISECONDS) }
        catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    }

    override fun restore(): Session? = restoreAccepted()?.session

    override fun restoreAccepted(): AcceptedOwner? = synchronized(lock) { restoreLocked() }

    /** Callers hold [lock]. A plain function: its early returns stay out of the inlined lock and fence. */
    private fun restoreLocked(): AcceptedOwner? {
        if (leftover) {
            wipeLocal(SessionEndCause.UNUSABLE_STORED_COPY, endingStoredCopy = true)
            return null
        }
        acceptedOwner?.let { return it }
        val data = try { store.load() } catch (_: TokenStoreException) {
            // Sealed with a key that is gone, or tampered with: it can never be used, so it goes.
            wipeLocal(SessionEndCause.UNUSABLE_STORED_COPY, endingStoredCopy = true); return null
        } ?: return null
        val envelope = decodeEnvelope(data)
        val restored = envelope?.let { (issuer, _) ->
            try { configuration.admit(issuer) } catch (_: SignInException) { null }
        }
        if (envelope == null || restored == null) {
            // Unreadable, or for an issuer this build no longer admits: never used, so wiped.
            wipeLocal(SessionEndCause.UNUSABLE_STORED_COPY, endingStoredCopy = true); return null
        }
        grant = StoredGrant(envelope.first, envelope.second)
        admitted = restored
        return AcceptedOwner(Session(restored.issuer, restored.realm), this, generation).also { acceptedOwner = it }
    }

    override fun resume(): Session? {
        val owner = restoreAccepted() ?: return null
        return try {
            accessTokenFor(owner, true)
            if (owner.isRetired) null else owner.session
        } catch (error: AccessTokenException) {
            if (error.failure == AccessTokenFailure.SIGNED_OUT || owner.isRetired) null else owner.session
        }
    }

    override fun accessToken(forceRefresh: Boolean): AccessToken {
        val owner = captureAcceptedOwner() ?: throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
        return accessTokenFor(owner, forceRefresh)
    }

    internal fun accessTokenFor(owner: AcceptedOwner, forceRefresh: Boolean): AccessToken =
        refreshing.withLock { refreshLocked(owner, forceRefresh) }

    /** Callers hold refreshing. R is the owner/grant capture under lock, after refresh serialization. */
    private fun refreshLocked(owner: AcceptedOwner, forceRefresh: Boolean): AccessToken {
        admissions.before()
        val (current, started) = synchronized(lock) {
            if (!owns(owner)) throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
            checkNotNull(grant) to generation
        }
        admissions.after()
        val fresh = try { backend.freshAccessToken(current, forceRefresh) } catch (error: BackendException) {
            when (error.failure) {
                BackendFailure.UNAVAILABLE, BackendFailure.CANCELLED -> throw AccessTokenException(AccessTokenFailure.UNAVAILABLE)
                BackendFailure.REFUSED, BackendFailure.PROTOCOL_VIOLATION -> {
                    synchronized(lock) { if (owns(owner)) wipeLocal(SessionEndCause.REFRESH_REFUSED) }
                    throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
                }
            }
        }
        synchronized(lock) {
            if (!owns(owner) || generation != started) throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
            if (fresh.grant != current) {
                try { persist(fresh.grant) } catch (_: TokenStoreException) {
                    wipeLocal(SessionEndCause.OTHER)
                    throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
                }
                grant = fresh.grant
            }
            return AccessToken(fresh.accessToken, started)
        }
    }

    /** Callers hold lock. Receipt identity also rejects another service with the same counter. */
    private fun owns(owner: AcceptedOwner): Boolean =
        acceptedOwner === owner && owner.service === this && !owner.isRetired && grant != null && generation == owner.generation

    /** S: the single attempt is admitted here. Network/observers never run while holding lock. */
    internal fun admitSend(owner: AcceptedOwner, token: AccessToken): Boolean = synchronized(lock) {
        owns(owner) && token.session == owner.generation
    }

    internal fun signOutFor(owner: AcceptedOwner) {
        val target = synchronized(lock) {
            if (!owns(owner)) return
            generation.also { signOutTarget = it }
        }
        end(target, revoke = true)
    }

    internal fun endSessionFor(owner: AcceptedOwner, token: AccessToken) {
        synchronized(lock) { if (!owns(owner) || token.session != owner.generation) return }
        end(token.session, revoke = false)
    }

    override fun signOut() {
        end(synchronized(lock) { generation.also { signOutTarget = it } }, revoke = true)
    }

    /** Core's second 401: wiped, never revoked (see the revocation policy above). */
    override fun endSession(token: AccessToken) {
        end(token.session, revoke = false)
    }

    /**
     * Ends the session of [target] generation. A sign-out ([revoke]) first waits up to
     * [signOutWaitMillis] for a refresh in flight, so the grant it revokes is the one that refresh
     * rotated to; past that it wipes anyway, and the refresh's own generation check drops whatever it
     * brings back. Without [revoke] nothing waits and nothing reaches the provider.
     */
    private fun end(target: Long, revoke: Boolean) {
        val wait = if (revoke) signOutWaitMillis else 0L
        val waited = try { refreshing.tryLock(wait, TimeUnit.MILLISECONDS) }
            catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
        val revoking = try {
            synchronized(lock) {
                // Fenced: a session that already ended, or a newer sign-in, is not this call's to end; a
                // sign-in that overtook this sign-out has revoked its grant already.
                if (generation != target) return@synchronized null
                val previous = if (revoke) grant?.let { g -> admitted?.let { Revoking(g, it) } } else null
                wipeLocal(if (revoke) SessionEndCause.EXPLICIT_SIGN_OUT else SessionEndCause.ENDED_BY_SERVER)
                previous
            }
        } finally { if (waited) refreshing.unlock() }
        // Wiped first: the session is gone locally even if the provider never answers.
        revoking?.send()
    }

    private fun persist(grant: StoredGrant) {
        val envelope = JsonObject().apply {
            addProperty("version", 1)
            addProperty("issuer", grant.issuer)
            addProperty("state", grant.state)
        }
        store.save(envelope.toString().toByteArray(Charsets.UTF_8))
    }

    private fun decodeEnvelope(data: ByteArray): Pair<String, String>? = try {
        val root = StrictJson.parse(data).objectValue()
        if (root.keys != setOf("version", "issuer", "state") || root.getValue("version").integerValue() != 1L) null
        else root.getValue("issuer").stringValue() to root.getValue("state").stringValue()
    } catch (_: DiscoveryDecodingException) { null }

    /**
     * Callers hold [lock]. A failed [TokenStore.wipe] ends memory and sets [leftover]: restore retries
     * cleanup and returns null for that call. The sealed store attempts key destruction before file
     * deletion; retained ciphertext is unreadable only if key destruction succeeded. If both fail,
     * this instance refuses restoration, but a new instance may still read the retained grant.
     *
     * The session-ended listeners hear of it, with [cause] and the generation being ended, when a session
     * is held in memory, or when the caller ends a stored copy ([endingStoredCopy]) that is not the
     * leftover of a wipe that failed in this process. A wipe with nothing held ends no session, whatever
     * its [cause].
     */
    private fun wipeLocal(cause: SessionEndCause, endingStoredCopy: Boolean = false) {
        val ending = grant != null || (endingStoredCopy && !leftover)
        // The generation the ended session's tokens carry; bumped next, so no later session shares it.
        val owner = acceptedOwner
        val event = SessionEnded(generation, cause, owner)
        owner?.retire()
        acceptedOwner = null
        generation++
        grant = null
        admitted = null
        leftover = try { store.wipe(); false } catch (_: TokenStoreException) { true }
        if (ending) for (listener in ended) { try { listener(event) } catch (_: RuntimeException) { } }
    }

    companion object {
        const val SIGN_OUT_WAIT_MILLIS = 5000L
        /** Longer than the revocation request's own 10-second call timeout. */
        const val REVOCATION_WAIT_MILLIS = 15000L
    }
}

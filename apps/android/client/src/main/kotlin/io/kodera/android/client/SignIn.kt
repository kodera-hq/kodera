package io.kodera.android.client

import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.DomainFailure
import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.LoopbackPolicy

/**
 * The protected sign-in configuration: the platform's public client, the issuer origins this build
 * admits, and whether a loopback development origin may be one of them.
 */
class SignInConfiguration(clientId: String, admittedIssuerOrigins: Set<String>, val loopback: LoopbackPolicy,
    /**
     * From the `kodera.offlineAccess` build setting, off unless set. On, the refresh token is an
     * offline token (idle 14 days, max 90, rotated with reuse detection), so a member stays signed in
     * across days without a browser round trip. Off, as the organisation realms are configured for
     * now (I-2), the session lasts as long as the realm's SSO session. Either way a refused refresh
     * returns to sign-in, and the token lives only in the sealed store.
     */
    val offlineAccess: Boolean = false) {
    val clientId: String
    val admittedIssuerOrigins: Set<String>

    /** What the authorization request asks for. */
    val scopes: List<String> get() = if (offlineAccess) BASE_SCOPES + OFFLINE_ACCESS_SCOPE else BASE_SCOPES

    init {
        if (clientId.length !in 1..128 || clientId.any { it.code !in 33..126 } || admittedIssuerOrigins.isEmpty()) {
            throw SignInException(SignInFailure.NOT_CONFIGURED)
        }
        for (origin in admittedIssuerOrigins) {
            try { IssuerAdmission.validateOrigin(origin, loopback) }
            catch (_: DomainFailure) { throw SignInException(SignInFailure.NOT_CONFIGURED) }
        }
        this.clientId = clientId
        this.admittedIssuerOrigins = admittedIssuerOrigins.toSet()
    }

    fun admit(issuer: String): AdmittedIssuer =
        try { IssuerAdmission.admit(issuer, admittedIssuerOrigins, loopback) }
        catch (_: DomainFailure) { throw SignInException(SignInFailure.UNTRUSTED_ISSUER) }

    companion object {
        /**
         * RFC 8252 private-use scheme. The literal scheme is fixed here and in the Gradle manifest
         * placeholder; it is never derived from the application ID or configured.
         */
        const val REDIRECT_URI = "io.kodera.app:/oauth2redirect"

        /** Keycloak adds the client's default scopes (basic, acr, profile, email, web-origins) itself. */
        val BASE_SCOPES: List<String> = listOf("openid")

        /** The native client's one optional scope, requested only when the build enables it. */
        const val OFFLINE_ACCESS_SCOPE = "offline_access"

        /** The build setting's value: exactly `true` turns offline access on; anything else leaves it off. */
        fun offlineAccessSetting(value: String): Boolean = value.trim().toBooleanStrictOrNull() == true
    }
}

/** A signed-in session as the interface sees it. It carries no token. */
data class Session(val issuer: String, val realm: String)

/**
 * An accepted grant lifetime, issued atomically by its concrete sign-in service. Equal public
 * sessions are not equal owners. No token is exposed; retirement is permanent, including failed wipes.
 */
class AcceptedOwner internal constructor(val session: Session, internal val service: KoderaSignInService,
    internal val generation: Long) {
    @Volatile var isRetired: Boolean = false
        private set
    internal fun retire() { isRetired = true }
    /** Launch's forced refresh, scoped to this exact owner. Call off the main thread. */
    fun refresh() { service.accessTokenFor(this, true) }
    /** Explicit sign-out of this owner only; a replacement is left untouched. Blocks. */
    fun signOut() { service.signOutFor(this) }
    override fun toString(): String = "AcceptedOwner(<redacted>)"
}

enum class SignInFailure {
    NOT_CONFIGURED,
    /** The issuer is not on an origin this build admits; nothing was opened. */
    UNTRUSTED_ISSUER,
    CANCELLED,
    IN_PROGRESS,
    /** The identity provider could not be reached, or no browser could present the page. */
    IDENTITY_UNAVAILABLE,
    /** The provider refused the request, or answered outside the protocol. */
    REFUSED,
    /** The session could not be written to this device; nothing is kept. */
    STORAGE,
}

class SignInException(val failure: SignInFailure) : Exception(failure.name)

/**
 * What the app asks of sign-in. The AppAuth implementation sits behind [AuthorizationBackend], so the
 * interface and the tests never touch AppAuth. Every method blocks: call it off the main thread.
 */
interface SignInService : AccessTokenProvider {
    /** Atomically returns the owner accepted by this operation, never a later current owner. */
    fun signInAccepted(issuer: String): AcceptedOwner
    /** No network. A repeated restore of the same held grant returns the same receipt. */
    fun restoreAccepted(): AcceptedOwner?
    /** Capture once when constructing a legacy requester; absent owners must fail closed. No store I/O. */
    fun captureAcceptedOwner(): AcceptedOwner?

    /**
     * A session still held when it starts (in memory, or a stored copy) is wiped first, before the
     * browser opens, and not revoked, unless a [signOut] is still waiting to end it: the sign-in then
     * sends that revocation itself. It also waits, bounded, for a revocation still in flight.
     * @throws SignInException
     */
    fun signIn(issuer: String): Session
    /** The session left on this device by a previous launch, if it is still admissible. No network. */
    fun restore(): Session?
    /**
     * Launch: [restore], then one silent forced refresh. A refused refresh has purged the state and
     * yields null (back to sign-in); an unreachable provider keeps the session.
     */
    fun resume(): Session?
    /**
     * Sign-out from the interface: waits briefly for a refresh in flight, so the token revoked is the
     * one the provider last rotated to, then wipes and revokes. The only call that revokes: Keycloak's
     * revocation ends this client's sessions for the member on every device. Fenced: if the session it
     * was called for has already ended or been replaced by the time it runs, it does nothing (a sign-in
     * that replaced it while it waited has revoked it already).
     */
    fun signOut()
    /** Whether a session is held in memory right now. Never blocks, never touches the store. */
    val isSignedIn: Boolean
    /**
     * [listener] is told once for each session the service ends, with which session and why, and never
     * for a call that ended nothing: features purge everything derived from that session. It runs at the
     * wipe, under the service's lock, so it must not block and must not call the service. The paths it
     * covers, and the wipes it does not report, are listed on
     * [KoderaSignInService.addSessionEndedListener].
     */
    fun addSessionEndedListener(listener: (SessionEnded) -> Unit)
}

/** Why the sign-in service ended a session. The names match iOS's `SessionEndCause`. */
enum class SessionEndCause {
    /**
     * The member's sign-out ([SignInService.signOut]), or the sign-in that took over one still waiting for
     * a refresh. The only cause that revoked the grant at the provider.
     */
    EXPLICIT_SIGN_OUT,
    /** The provider refused a refresh. */
    REFRESH_REFUSED,
    /** Core refused a freshly refreshed token: its second 401 ([AccessTokenProvider.endSession]). */
    ENDED_BY_SERVER,
    /** A sign-in replaced a session held in memory or a stored copy, before its browser opened. */
    REPLACED,
    /** [SignInService.restore] found a stored copy it cannot use: unreadable, or for an issuer no longer admitted. */
    UNUSABLE_STORED_COPY,
    /** Any other end: a rotated grant the store could not keep. */
    OTHER,
}

/**
 * One ended session, as the session-ended listeners hear of it. [session] is the ended session's
 * identity: the `session` its access tokens carried ([AccessToken.session]), the generation the service
 * fences on. Each ended session in one process has its own.
 */
data class SessionEnded(val session: Long, val cause: SessionEndCause,
    /** Captured before retirement; null only for a stored copy that was never accepted in memory. */
    val owner: AcceptedOwner? = null)

package io.kodera.android.auth

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import io.kodera.android.client.AuthorizationBackend
import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import io.kodera.android.client.DiscoveredEndpoints
import io.kodera.android.client.FreshToken
import io.kodera.android.client.Revocation
import io.kodera.android.client.SignInConfiguration
import io.kodera.android.client.StoredGrant
import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.LoopbackPolicy
import net.openid.appauth.AppAuthConfiguration
import net.openid.appauth.AuthState
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.browser.AnyBrowserMatcher
import net.openid.appauth.browser.BrowserMatcher
import net.openid.appauth.connectivity.ConnectionBuilder
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Starts the browser intent AppAuth prepares; the Activity owns the result launcher. */
internal fun interface AuthorizationPresenter {
    /** On the main thread. False when no started Activity can present it. */
    fun present(intent: Intent): Boolean
}

/**
 * The browsers AppAuth may open sign-in in; its `BrowserSelector` picks one of them. Sign-in is the only
 * page the app opens in a browser.
 */
internal val SIGN_IN_BROWSERS: BrowserMatcher = AnyBrowserMatcher.INSTANCE

/** AppAuth's configuration for sign-in: [SIGN_IN_BROWSERS], [connections], and the issuer HTTPS check. */
internal fun appAuthConfiguration(loopback: LoopbackPolicy, connections: ConnectionBuilder): AppAuthConfiguration =
    AppAuthConfiguration.Builder()
        .setBrowserMatcher(SIGN_IN_BROWSERS)
        .setConnectionBuilder(connections)
        // A plain-HTTP issuer is only ever admitted in a debug build, for the local realm.
        .setSkipIssuerHttpsCheck(AppAuthChecks.skipIssuerHttpsCheck(loopback))
        .build()

/** Whether [intent] carries an AppAuth answer (a response or an error), as a completion intent does. */
internal fun carriesAuthorizationResult(intent: Intent?): Boolean = intent != null &&
    (intent.hasExtra(AuthorizationResponse.EXTRA_RESPONSE) || intent.hasExtra(AuthorizationException.EXTRA_EXCEPTION))

/**
 * AppAuth behind [AuthorizationBackend]: discovery from the admitted issuer, authorization code with
 * PKCE S256 in a Custom Tab (AppAuth's default browser matching, the browser's normal shared
 * session), the RFC 9207 `iss` check, the code exchange with AppAuth's ID token checks, refresh, and
 * RFC 7009 revocation. The security decisions themselves are [AppAuthChecks] and [ConnectionPolicy].
 *
 * Every AppAuth call runs on the main thread, where AppAuth delivers its callbacks; the blocking
 * methods wait for them on the caller's worker thread. Only the serialised `AuthState` leaves here.
 * The app holds one per process.
 */
internal class AppAuthBackend(context: Context, private val loopback: LoopbackPolicy) : AuthorizationBackend,
    BrowserAuthorization {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val rotations = LateRotations()
    private val browser = BrowserStep<Intent>()
    private var presenter: AuthorizationPresenter? = null
    private var closed = false
    /** Main thread only. */
    private var service: AuthorizationService? = null

    override fun attach(presenter: AuthorizationPresenter) { synchronized(lock) { this.presenter = presenter } }

    override fun detach(presenter: AuthorizationPresenter) {
        synchronized(lock) { if (this.presenter === presenter) this.presenter = null }
    }

    /**
     * The Activity result of the browser step. False when no open browser step waits for it: the
     * process was recreated while the browser was open (the request, its verifier and its nonce are
     * gone), or the sign-in was cancelled or timed out first.
     */
    override fun onAuthorizationResult(data: Intent?): Boolean = browser.deliver(data)

    override fun cancelAuthorization(): Boolean = browser.cancel()

    fun close() {
        synchronized(lock) { closed = true; presenter = null }
        browser.close()
        main.post { service?.dispose(); service = null }
    }

    override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant {
        // Claimed before discovery, so a cancel reaches every step of this sign-in.
        val claim = browser.claim() ?: throw failure(BackendFailure.UNAVAILABLE)
        try {
            return authorize(claim, issuer, configuration)
        } finally {
            browser.release(claim)
        }
    }

    private fun authorize(claim: BrowserStep.Claim<Intent>, issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant {
        val discovered = onMain<AuthorizationServiceConfiguration> { call ->
            AuthorizationServiceConfiguration.fetchFromIssuer(Uri.parse(issuer.issuer), { found, error ->
                if (found != null) call.answer(found) else call.fail(classify(error))
            }, connections())
        }
        browser.ensureLive(claim)
        val document = discovered.discoveryDoc ?: throw failure(BackendFailure.PROTOCOL_VIOLATION)
        DiscoveredEndpoints.check(document.issuer, discovered.authorizationEndpoint.toString(),
            discovered.tokenEndpoint.toString(), issuer)
        // The builder generates state, nonce and a PKCE verifier; S256 is required, never plain.
        val request = AuthorizationRequest.Builder(discovered, configuration.clientId, ResponseTypeValues.CODE,
            Uri.parse(SignInConfiguration.REDIRECT_URI)).setScopes(configuration.scopes).build()
        AppAuthChecks.requireS256(request.codeVerifierChallengeMethod)
        browser.presenting(claim)
        browser.ensureLive(claim)
        val presented = onMain<Boolean> { call ->
            val target = synchronized(lock) { presenter }
            call.answer(try { target?.present(authorizationService().getAuthorizationRequestIntent(request)) == true }
                catch (_: ActivityNotFoundException) { false })
        }
        if (!presented) throw failure(BackendFailure.UNAVAILABLE)
        // Bounded: a cancel, a fresh Activity that can never receive the result, or the step's limit ends it.
        val data = browser.await(claim)
        val response = AuthorizationResponse.fromIntent(data)
            ?: throw failure(classify(AuthorizationException.fromIntent(data)))
        AppAuthChecks.checkAuthorizationResponse(request.state, response.state,
            response.additionalParameters[AppAuthChecks.ISSUER_PARAMETER], issuer.issuer,
            AppAuthChecks.advertisesIssuerParameter(document.docJson.opt(AppAuthChecks.ISSUER_PARAMETER_SUPPORTED)))
        browser.ensureLive(claim)
        val state = AuthState(response, null)
        // An exchange that answers after the wait gave up is dropped, not revoked: only an explicit
        // sign-out revokes (see KoderaSignInService), and AppAuth's state goes with this call.
        val exchanged = onMain<AuthorizationException?> { call ->
            authorizationService().performTokenRequest(response.createTokenExchangeRequest()) { tokens, error ->
                state.update(tokens, error)
                call.answer(error)
            }
        }
        if (exchanged != null) throw failure(classify(exchanged))
        // A refused or cancelled exchange drops whatever it issued, and revokes nothing: Keycloak's
        // revocation would end this client's sessions for the member on every device.
        AppAuthChecks.checkTokenResponse(state.isAuthorized, state.accessToken, state.idToken)
        // Cancelled while the code was being exchanged: the member asked to stop, so nothing is kept.
        browser.ensureLive(claim)
        return StoredGrant(issuer.issuer, state.jsonSerializeString())
    }

    override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken {
        // A refresh that answered too late for its caller rotated the token; that state is the live one.
        val state = deserialize(rotations.peek(grant.state) ?: grant.state) ?: throw failure(BackendFailure.PROTOCOL_VIOLATION)
        if (forceRefresh) state.needsTokenRefresh = true
        val (token, error) = onMain<Pair<String?, AuthorizationException?>>(late = { (lateToken, lateError) ->
            if (lateToken != null && lateError == null) rotations.record(grant.state, state.jsonSerializeString())
        }) { call ->
            state.performActionWithFreshTokens(authorizationService()) { accessToken, _, problem -> call.answer(accessToken to problem) }
        }
        if (error != null) throw failure(AppAuthErrors.refreshOutcome(state.isAuthorized, error.error))
        val fresh = FreshToken(token ?: throw failure(BackendFailure.REFUSED), StoredGrant(grant.issuer, state.jsonSerializeString()))
        rotations.clear(grant.state)
        return fresh
    }

    override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) {
        // Called only by an explicit sign-out. The latest rotation is the live token.
        val latest = rotations.peek(grant.state) ?: grant.state
        // A refresh of this grant still with the provider may yet rotate it: what that brings back is
        // dropped, never kept and never revoked (this revocation already ends the client's sessions).
        rotations.retire(grant.state)
        val state = deserialize(latest) ?: return
        val token = state.refreshToken ?: return
        val endpoint = state.authorizationServiceConfiguration?.discoveryDoc?.docJson
            ?.optString(REVOCATION_ENDPOINT)?.takeIf { it.isNotEmpty() } ?: return
        try { Revocation.revoke(endpoint, token, configuration.clientId, issuer) } catch (_: RuntimeException) { }
    }

    private fun deserialize(json: String): AuthState? = AppAuthChecks.decodeOrNull(json) { AuthState.jsonDeserialize(it) }

    /** On the main thread only. Refused once closed, so a call that lands after [close] never leaks a service. */
    private fun authorizationService(): AuthorizationService {
        if (synchronized(lock) { closed }) throw failure(BackendFailure.UNAVAILABLE)
        return service ?: AuthorizationService(context, appAuthConfiguration(loopback, connections())).also { service = it }
    }

    private fun connections(): ConnectionBuilder = LoopbackAwareConnections(loopback)

    /**
     * Runs [block] on the main thread and waits for its single answer. Past [CALL_SECONDS] the caller
     * gets "unavailable"; an answer that still arrives goes to [late] (on the main thread), so a
     * refresh that rotated the token is not silently lost. Without [late], a late answer is dropped.
     */
    private fun <T> onMain(late: ((T) -> Unit)? = null, block: (call: MainCall<T>) -> Unit): T {
        if (Looper.myLooper() == Looper.getMainLooper()) error("AppAuthBackend blocks; call it off the main thread")
        val call = MainCall<T>()
        main.post {
            try { block(call) }
            catch (error: BackendException) { call.fail(error.failure) }
            catch (_: RuntimeException) { call.fail(BackendFailure.PROTOCOL_VIOLATION) }
        }
        return call.await(CALL_SECONDS, late)
    }

    /** One main-thread call's answer, or its failure, handed to the waiting worker exactly once. */
    private class MainCall<T> {
        private val latch = CountDownLatch(1)
        private var answered = false
        private var abandoned: ((T) -> Unit)? = null
        private var value: T? = null
        private var refusal: BackendFailure? = null

        fun answer(result: T) {
            val late = synchronized(this) {
                if (answered) return
                answered = true
                value = result
                latch.countDown()
                abandoned
            }
            late?.invoke(result)
        }

        fun fail(kind: BackendFailure) {
            synchronized(this) {
                if (answered) return
                answered = true
                refusal = kind
                latch.countDown()
            }
        }

        fun await(seconds: Long, late: ((T) -> Unit)?): T {
            try { latch.await(seconds, TimeUnit.SECONDS) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
            synchronized(this) {
                if (!answered) {
                    abandoned = late ?: {}
                    throw BackendException(BackendFailure.UNAVAILABLE)
                }
                refusal?.let { throw BackendException(it) }
                @Suppress("UNCHECKED_CAST") return value as T
            }
        }
    }

    private companion object {
        /**
         * Each AppAuth step is one HTTP exchange, bounded by the connection's 15 s connect and 15 s
         * read timeouts; the rest is headroom for a busy main thread. A late refresh answer is kept:
         * see [onMain].
         */
        const val CALL_SECONDS = 45L
        const val REVOCATION_ENDPOINT = "revocation_endpoint"

        fun failure(kind: BackendFailure) = BackendException(kind)

        fun classify(error: AuthorizationException?): BackendFailure =
            if (error == null) BackendFailure.PROTOCOL_VIOLATION else AppAuthErrors.classify(error.type, error.code)
    }
}

/** AppAuth's error space mapped onto the four outcomes the session owner acts on. Pure, host-tested. */
internal object AppAuthErrors {
    fun classify(type: Int, code: Int): BackendFailure = when (type) {
        AuthorizationException.TYPE_OAUTH_AUTHORIZATION_ERROR, AuthorizationException.TYPE_OAUTH_TOKEN_ERROR -> BackendFailure.REFUSED
        AuthorizationException.TYPE_GENERAL_ERROR -> when (code) {
            USER_CANCELED, PROGRAM_CANCELED -> BackendFailure.CANCELLED
            NETWORK_ERROR, SERVER_ERROR -> BackendFailure.UNAVAILABLE
            else -> BackendFailure.PROTOCOL_VIOLATION
        }
        else -> BackendFailure.PROTOCOL_VIOLATION
    }

    /**
     * A failed refresh signs out only on a real refusal: AppAuth marks the state unauthorized after an
     * OAuth error from the token endpoint, and the error is not a transient one. A malformed or
     * captive-portal response, an ID token rejected for clock skew, or an unreachable provider keeps
     * the session. (A state that cannot be deserialised is a protocol violation, and is wiped.)
     * Kept only until the next refresh, when the provider did answer: Keycloak rotates refresh tokens
     * with `refreshTokenMaxReuse` 0, so a response discarded here took the rotated token with it, and
     * the next refresh, with the old one, is refused and signs out.
     */
    fun refreshOutcome(stillAuthorized: Boolean, oauthError: String?): BackendFailure =
        if (!stillAuthorized && oauthError !in TRANSIENT_OAUTH_ERRORS) BackendFailure.REFUSED else BackendFailure.UNAVAILABLE

    private val TRANSIENT_OAUTH_ERRORS = setOf("temporarily_unavailable", "server_error")

    // AuthorizationException.GeneralErrors codes, which AppAuth does not publish as constants;
    // AppAuthErrorsTests pins each against the library.
    const val PROGRAM_CANCELED = 2
    const val USER_CANCELED = 1
    const val NETWORK_ERROR = 3
    const val SERVER_ERROR = 4
}

/**
 * HTTPS everywhere. Plain HTTP only to the exact loopback origins a debug build admits (and the debug
 * network security configuration lets through); a release build refuses it before any socket opens.
 * Redirects are never followed and nothing is cached.
 */
internal class LoopbackAwareConnections(private val loopback: LoopbackPolicy) : ConnectionBuilder {
    override fun openConnection(uri: Uri): HttpURLConnection = open(uri.toString())

    /**
     * The policy and the connection read the same parse of [url], so they cannot disagree on its
     * origin. Opens, never connects: host-testable.
     */
    fun open(url: String): HttpURLConnection {
        val parsed = try { URL(url) } catch (_: MalformedURLException) { throw IOException("Refused a malformed endpoint") }
        if (!ConnectionPolicy.admits(parsed.protocol, parsed.authority, loopback)) {
            throw IOException("Refused a connection outside the admitted schemes")
        }
        return (parsed.openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MILLIS
            readTimeout = TIMEOUT_MILLIS
            instanceFollowRedirects = false
            useCaches = false
        }
    }

    companion object {
        const val TIMEOUT_MILLIS = 15000
    }
}

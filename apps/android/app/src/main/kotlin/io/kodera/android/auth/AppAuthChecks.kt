package io.kodera.android.auth

import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.LoopbackPolicy
import org.json.JSONException

/**
 * The security decisions of the AppAuth adapter, as pure functions over strings, so `:app`'s host
 * tests prove each one without a device, a browser or AppAuth's Android classes. Each refusal throws
 * [BackendException] with the failure the session owner acts on.
 */
internal object AppAuthChecks {
    const val PKCE_S256 = "S256"
    const val ISSUER_PARAMETER = "iss"
    const val ISSUER_PARAMETER_SUPPORTED = "authorization_response_iss_parameter_supported"

    /** PKCE with S256 only; `plain`, or no challenge at all, is refused before the browser opens. */
    fun requireS256(method: String?) {
        if (method != PKCE_S256) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
    }

    /**
     * The browser's answer, before its code is exchanged. The returned `state` must be the request's.
     * RFC 9207: when discovery advertises `authorization_response_iss_parameter_supported` (Keycloak
     * does), an answer without `iss` is refused; otherwise an absent `iss` is accepted, since the
     * discovery check already bound the endpoints. A present `iss` must be exactly the admitted issuer.
     */
    fun checkAuthorizationResponse(expectedState: String?, returnedState: String?, issParameter: String?,
        admittedIssuer: String, issSupported: Boolean) {
        if (expectedState == null || returnedState != expectedState) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
        if (issParameter == null) {
            if (issSupported) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
            return
        }
        if (issParameter != admittedIssuer) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
    }

    /** The discovery document's own claim, read strictly: only a JSON `true` counts. */
    fun advertisesIssuerParameter(value: Any?): Boolean = value == true

    /**
     * The code exchange's result. Without an access token, or with a state AppAuth does not call
     * authorized, the provider refused; without an ID token, AppAuth's nonce, issuer and audience
     * checks did not run, which is a protocol violation.
     */
    fun checkTokenResponse(isAuthorized: Boolean, accessToken: String?, idToken: String?) {
        if (!isAuthorized || accessToken == null) throw BackendException(BackendFailure.REFUSED)
        if (idToken == null) throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
    }

    /** AppAuth's own HTTPS check on the issuer is skipped only where plain-HTTP loopback is admitted: debug builds. */
    fun skipIssuerHttpsCheck(loopback: LoopbackPolicy): Boolean = loopback.admitsLoopback

    /**
     * A stored `AuthState` that cannot be read back is unusable, not a crash: AppAuth's deserialisers
     * throw [JSONException], and its preconditions `IllegalArgumentException` (`checkNotEmpty`,
     * `checkArgument`), `NullPointerException` (`checkNotNull`) or `IllegalStateException`.
     */
    fun <T : Any> decodeOrNull(json: String, decode: (String) -> T): T? = try { decode(json) }
        catch (_: JSONException) { null }
        catch (_: IllegalArgumentException) { null }
        catch (_: IllegalStateException) { null }
        catch (_: NullPointerException) { null }
}

/**
 * Which connections AppAuth may open: HTTPS anywhere, plain HTTP only to an exact loopback origin
 * and only when the build admits loopback (debug). A release build refuses it before any socket opens.
 */
internal object ConnectionPolicy {
    const val HTTPS = "https"
    private const val HTTP = "http"
    private const val SEPARATOR = "://"

    fun admits(scheme: String?, authority: String?, loopback: LoopbackPolicy): Boolean {
        if (scheme == HTTPS) return true
        return loopback.admitsLoopback && scheme == HTTP && authority != null &&
            IssuerAdmission.isLoopbackDevelopmentOrigin(HTTP + SEPARATOR + authority)
    }
}

/**
 * A refresh that answered after its caller gave up waiting still rotated the refresh token, and
 * Keycloak refuses the old one (`refreshTokenMaxReuse` 0). The adapter keeps the rotated state here,
 * keyed by the grant it came from, and uses it on the next refresh or revocation of that grant. One
 * slot: only the latest grant matters. Lost if the process dies first.
 *
 * Once a grant has been signed out it is retired: a late answer for it is dropped, never kept, and
 * never revoked (the sign-out's own revocation already ended the client's sessions).
 */
internal class LateRotations {
    private val lock = Any()
    private var original: String? = null
    private var rotated: String? = null
    private var retired: String? = null

    /** A late answer: [rotatedState] is what [originalState] rotated to. Dropped once that grant is retired. */
    fun record(originalState: String, rotatedState: String) {
        synchronized(lock) {
            if (originalState == retired) retired = null
            else { original = originalState; rotated = rotatedState }
        }
    }

    /** The rotated state for [originalState], if a late answer left one. */
    fun peek(originalState: String): String? = synchronized(lock) { if (original == originalState) rotated else null }

    /** Forget the slot once the grant it belongs to has been replaced. */
    fun clear(originalState: String) {
        synchronized(lock) { if (original == originalState) { original = null; rotated = null } }
    }

    /** [originalState] was signed out: its slot goes, and a late answer for it is dropped. */
    fun retire(originalState: String) {
        synchronized(lock) {
            if (original == originalState) { original = null; rotated = null }
            retired = originalState
        }
    }
}

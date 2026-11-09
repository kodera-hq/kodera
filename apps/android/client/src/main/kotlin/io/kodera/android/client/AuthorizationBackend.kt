package io.kodera.android.client

import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.IssuerAdmission

/** An opaque, serialised grant (AppAuth's `AuthState` JSON) and the issuer it belongs to. Secret. */
class StoredGrant(val issuer: String, val state: String) {
    override fun equals(other: Any?): Boolean = other is StoredGrant && issuer == other.issuer && state == other.state
    override fun hashCode(): Int = listOf(issuer, state).hashCode()
    override fun toString(): String = "StoredGrant(<redacted>)"
}

/** A currently valid access token and the grant as it stands after any refresh. Secret. */
class FreshToken(val accessToken: String, val grant: StoredGrant) {
    override fun toString(): String = "FreshToken(<redacted>)"
}

enum class BackendFailure {
    CANCELLED,
    /** An OAuth error from the provider: the grant is no longer usable. */
    REFUSED,
    /** Network or presentation trouble: nothing about the grant is known. */
    UNAVAILABLE,
    PROTOCOL_VIOLATION,
}

class BackendException(val failure: BackendFailure) : Exception(failure.name)

/**
 * The browser, token and revocation calls. The app's AppAuth adapter is the production
 * implementation; tests substitute a fake, so no browser or network is needed. Every method blocks.
 */
interface AuthorizationBackend {
    /** @throws BackendException */
    fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant
    /** @throws BackendException */
    fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken
    /**
     * Best effort: revoke the refresh token at the issuer's RFC 7009 endpoint, if it publishes one.
     * Called for an explicit sign-out only (see [KoderaSignInService]).
     */
    fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration)
}

/** The checks a backend runs on the issuer's discovery document before any code or token moves. */
object DiscoveredEndpoints {
    /**
     * The document must name exactly the admitted issuer, and the endpoints that receive the code
     * and tokens must sit on its origin.
     * @throws BackendException with [BackendFailure.PROTOCOL_VIOLATION]
     */
    fun check(documentIssuer: String?, authorizationEndpoint: String, tokenEndpoint: String, issuer: AdmittedIssuer) {
        if (documentIssuer != issuer.issuer || !IssuerAdmission.sharesOrigin(authorizationEndpoint, issuer) ||
            !IssuerAdmission.sharesOrigin(tokenEndpoint, issuer)) {
            throw BackendException(BackendFailure.PROTOCOL_VIOLATION)
        }
    }
}

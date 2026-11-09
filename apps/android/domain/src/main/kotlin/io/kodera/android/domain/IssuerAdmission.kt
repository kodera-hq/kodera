package io.kodera.android.domain

/**
 * Whether a plain-HTTP loopback origin may be configured. Only a debug build passes
 * [ADMIT_FOR_DEVELOPMENT]; the decision is compiled into the app's debug source set, never read
 * from configuration. The app's other source sets ask [admitsLoopback] and never name the value
 * (check-app-resources.py refuses it there).
 */
enum class LoopbackPolicy {
    REFUSE,
    ADMIT_FOR_DEVELOPMENT;

    /** True only for [ADMIT_FOR_DEVELOPMENT]. */
    val admitsLoopback: Boolean get() = this == ADMIT_FOR_DEVELOPMENT
}

/**
 * An issuer that exactly equals one configured origin plus `/realms/{slug}`. Only
 * [IssuerAdmission.admit] creates one; holding it proves nothing about identity or membership.
 */
class AdmittedIssuer internal constructor(val issuer: String, val origin: String, val realm: String) {
    override fun equals(other: Any?): Boolean =
        other is AdmittedIssuer && issuer == other.issuer && origin == other.origin && realm == other.realm
    override fun hashCode(): Int = listOf(issuer, origin, realm).hashCode()
    override fun toString(): String = "AdmittedIssuer($issuer)"
}

/**
 * The trust check in front of every browser sign-in: the realm issuer must sit on an origin the
 * protected build configuration admits. Form text, deep links and responses cannot widen it.
 */
object IssuerAdmission {
    /**
     * HTTPS origins follow [TrustPolicy.validateOrigin] without a trailing slash. With
     * [LoopbackPolicy.ADMIT_FOR_DEVELOPMENT], the exact forms `http://localhost:PORT` and
     * `http://127.0.0.1:PORT` are also accepted, and nothing else over HTTP.
     */
    fun validateOrigin(value: String, loopback: LoopbackPolicy) {
        if (value.startsWith("https://")) {
            TrustPolicy.validateOrigin(value)
            if (value.endsWith('/')) throw DomainFailure(DomainError.INVALID_ORIGIN)
            return
        }
        if (loopback != LoopbackPolicy.ADMIT_FOR_DEVELOPMENT || !isLoopbackDevelopmentOrigin(value)) {
            throw DomainFailure(DomainError.INVALID_ORIGIN)
        }
    }

    fun admit(issuer: String, admittedOrigins: Set<String>, loopback: LoopbackPolicy): AdmittedIssuer {
        if (admittedOrigins.isEmpty()) throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
        admittedOrigins.forEach { validateOrigin(it, loopback) }
        // Exact raw comparison: no URL normalisation, so encoded paths, ports, user info,
        // trailing segments and case variants never match.
        for (origin in admittedOrigins.sorted()) {
            val prefix = "$origin/realms/"
            if (!issuer.startsWith(prefix)) continue
            val realm = issuer.substring(prefix.length)
            if (!TrustPolicy.canonicalSlug(realm)) throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
            return AdmittedIssuer(issuer, origin, realm)
        }
        throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
    }

    /**
     * True when [url] sits on the admitted issuer's exact origin (same scheme, host and port).
     * Codes, tokens and refresh tokens are only ever sent to such an endpoint.
     */
    fun sharesOrigin(url: String, issuer: AdmittedIssuer): Boolean =
        url.startsWith(issuer.origin + "/") && TrustPolicy.isVisibleASCII(url) && '\\' !in url && '@' !in url

    fun isLoopbackDevelopmentOrigin(value: String): Boolean {
        for (host in listOf("http://localhost:", "http://127.0.0.1:")) {
            if (!value.startsWith(host)) continue
            val port = value.substring(host.length)
            if (port.length !in 1..5 || port.any { it !in '0'..'9' } || port.first() == '0') return false
            return port.toInt() in 1..65535
        }
        return false
    }
}

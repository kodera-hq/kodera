package io.kodera.android.domain

import java.net.URI
import java.net.URISyntaxException
import java.util.Collections
import java.util.LinkedHashSet

/** Pure local values; validation never establishes authentication, authority or reachability. */
enum class DomainError {
    INVALID_ORIGIN, UNTRUSTED_ISSUER, INVALID_ORGANISATION, INVALID_SLUG, MISMATCHED_REALM,
    MISMATCHED_WELL_KNOWN, UNSUPPORTED_CONTRACT, UNSUPPORTED_READINESS, SELECTION_REQUIRED,
    MISMATCHED_ORGANISATION, UNTRUSTED_PROVENANCE, CALLBACK_MISMATCH, UNSUPPORTED_SUBJECT,
    IDENTITY_MISMATCH, STALE_GENERATION, INVALID_CHANNEL
}

class DomainFailure(val code: DomainError) : Exception(code.name)

enum class UnavailabilityReason {
    NOT_CONFIGURED, UNSUPPORTED_CONTRACT, SERVICE_UNAVAILABLE, IDENTITY_REQUIRED, FORBIDDEN
}

sealed interface ServiceReadiness {
    data class Unavailable(val reason: UnavailabilityReason) : ServiceReadiness
    data object Pending : ServiceReadiness
    data object Ready : ServiceReadiness
    data object Unknown : ServiceReadiness
}

data class EnvironmentTrust(
    val coreApiOrigin: String,
    val admittedIssuerOrigins: Set<String>,
    val nativeClientId: String,
    val redirectUri: String,
    val matrixRedirectUri: String
)

/**
 * Immutable anonymous origin configuration; validation establishes no identity or membership.
 * Origins go through [IssuerAdmission.validateOrigin], the same validator sign-in uses: HTTPS, or the
 * exact loopback forms when a debug build passes [LoopbackPolicy.ADMIT_FOR_DEVELOPMENT].
 */
class DiscoveryTrust private constructor(
    val coreApiOrigin: String,
    internal val admittedIssuerOrigins: Set<String>,
    internal val loopback: LoopbackPolicy,
) {
    companion object {
        fun configured(coreApiOrigin: String, admittedIssuerOrigins: Set<String>,
                       loopback: LoopbackPolicy = LoopbackPolicy.REFUSE): DiscoveryTrust {
            val origins = LinkedHashSet(admittedIssuerOrigins)
            IssuerAdmission.validateOrigin(coreApiOrigin, loopback)
            if (origins.isEmpty()) throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
            origins.forEach { origin ->
                if (origin.endsWith('/')) throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
                IssuerAdmission.validateOrigin(origin, loopback)
            }
            return DiscoveryTrust(coreApiOrigin, Collections.unmodifiableSet(origins), loopback)
        }
    }
}

data class DiscoverySelection(
    val organisationId: String,
    val organisationSlug: String,
    val realm: String,
    val issuer: String,
    val openidConfigurationUrl: String
)

data class CollaborationDescriptor(
    val schemaVersion: Int?,
    val organisationId: String,
    val matrixServerName: String,
    val homeserverOrigin: String,
    val roomAccessOrigin: String,
    val readiness: ServiceReadiness?
)

/** Future adapter assertion only; this value verifies no HTTP response, token or membership. */
sealed interface DescriptorProvenance {
    data object Unverified : DescriptorProvenance
    data class AuthenticatedCore(
        val origin: String, val organisationId: String, val issuer: String, val subject: String
    ) : DescriptorProvenance
}

enum class CallbackHop { CORE, MATRIX }

/** Private construction and a validating factory prevent unvalidated copies across modules. */
class ValidatedDiscovery private constructor(val selection: DiscoverySelection) {
    companion object {
        internal fun validate(value: DiscoverySelection, environment: EnvironmentTrust): ValidatedDiscovery {
            TrustPolicy.validateOrigin(environment.coreApiOrigin)
            if (environment.nativeClientId.isEmpty() || !TrustPolicy.isVisibleASCII(environment.nativeClientId)) {
                throw DomainFailure(DomainError.UNSUPPORTED_CONTRACT)
            }
            return validateMetadata(value, environment.admittedIssuerOrigins)
        }

        internal fun validate(value: DiscoverySelection, trust: DiscoveryTrust): ValidatedDiscovery {
            IssuerAdmission.validateOrigin(trust.coreApiOrigin, trust.loopback)
            return validateMetadata(value, trust.admittedIssuerOrigins, trust.loopback)
        }

        private fun validateMetadata(value: DiscoverySelection, admittedIssuerOrigins: Set<String>,
                                     loopback: LoopbackPolicy = LoopbackPolicy.REFUSE): ValidatedDiscovery {
            if (!TrustPolicy.canonicalNonNilUUID(value.organisationId)) throw DomainFailure(DomainError.INVALID_ORGANISATION)
            if (!TrustPolicy.canonicalSlug(value.organisationSlug)) throw DomainFailure(DomainError.INVALID_SLUG)
            if (value.realm != value.organisationSlug) throw DomainFailure(DomainError.MISMATCHED_REALM)
            admittedIssuerOrigins.forEach { IssuerAdmission.validateOrigin(it, loopback) }
            // The one issuer check sign-in runs too: exactly a configured origin plus `/realms/{slug}`, by raw
            // comparison, so encoded paths, ports, suffixes and controls never match. A discovered issuer
            // outside the configured origins, or a loopback one in a build that refuses loopback, stops here,
            // before any browser can open.
            val admitted = IssuerAdmission.admit(value.issuer, admittedIssuerOrigins, loopback)
            if (admitted.realm != value.realm) throw DomainFailure(DomainError.UNTRUSTED_ISSUER)
            if (value.openidConfigurationUrl != "${value.issuer}/.well-known/openid-configuration") {
                throw DomainFailure(DomainError.MISMATCHED_WELL_KNOWN)
            }
            return ValidatedDiscovery(value)
        }
    }
}

class ValidatedDescriptor private constructor(
    val descriptor: CollaborationDescriptor,
    val coreIdentity: CoreIdentity,
    val readiness: ServiceReadiness
) {
    val canAttemptConnection: Boolean get() = readiness == ServiceReadiness.Ready

    companion object {
        internal fun validate(
            value: CollaborationDescriptor, discovery: ValidatedDiscovery, coreIdentity: CoreIdentity,
            environment: EnvironmentTrust, provenance: DescriptorProvenance
        ): ValidatedDescriptor {
            TrustPolicy.validateDiscovery(discovery.selection, environment)
            if (value.schemaVersion != 1) throw DomainFailure(DomainError.UNSUPPORTED_CONTRACT)
            if (coreIdentity.organisationId != discovery.selection.organisationId ||
                value.organisationId != coreIdentity.organisationId || coreIdentity.issuer != discovery.selection.issuer) {
                throw DomainFailure(DomainError.MISMATCHED_ORGANISATION)
            }
            if (coreIdentity.subject.isEmpty() || !TrustPolicy.isVisibleASCII(coreIdentity.subject)) {
                throw DomainFailure(DomainError.UNSUPPORTED_SUBJECT)
            }
            if (provenance !is DescriptorProvenance.AuthenticatedCore || provenance.origin != environment.coreApiOrigin ||
                provenance.organisationId != coreIdentity.organisationId || provenance.issuer != coreIdentity.issuer ||
                provenance.subject != coreIdentity.subject) {
                throw DomainFailure(DomainError.UNTRUSTED_PROVENANCE)
            }
            TrustPolicy.validateOrigin(value.homeserverOrigin)
            TrustPolicy.validateOrigin(value.roomAccessOrigin)
            if (!TrustPolicy.validDNSName(value.matrixServerName)) throw DomainFailure(DomainError.INVALID_ORIGIN)
            val readiness = value.readiness
            if (readiness == null || readiness == ServiceReadiness.Unknown) {
                throw DomainFailure(DomainError.UNSUPPORTED_READINESS)
            }
            return ValidatedDescriptor(value, coreIdentity, readiness)
        }
    }
}

object TrustPolicy {
    /** Validate raw strings before URI parsing can normalize security-relevant input. */
    fun validateOrigin(value: String) {
        if (!value.startsWith("https://") || !isVisibleASCII(value) ||
            !validDNSName(value.substring(8).removeSuffix("/"))) {
            throw DomainFailure(DomainError.INVALID_ORIGIN)
        }
    }

    fun validateDiscovery(value: DiscoverySelection, environment: EnvironmentTrust): ValidatedDiscovery =
        ValidatedDiscovery.validate(value, environment)

    /** Anonymous metadata only: protected origins never substitute for a full identity profile. */
    fun validateDiscovery(value: DiscoverySelection, trust: DiscoveryTrust): ValidatedDiscovery =
        ValidatedDiscovery.validate(value, trust)

    fun selectDiscovery(
        values: List<DiscoverySelection>, selectedOrganisationId: String?, environment: EnvironmentTrust
    ): ValidatedDiscovery? {
        val candidates = values.map { validateDiscovery(it, environment) }
        if (selectedOrganisationId != null) {
            val matches = candidates.filter { it.selection.organisationId == selectedOrganisationId }
            if (matches.size != 1) throw DomainFailure(DomainError.SELECTION_REQUIRED)
            return matches.single()
        }
        if (candidates.size > 1) throw DomainFailure(DomainError.SELECTION_REQUIRED)
        return candidates.firstOrNull()
    }

    fun validateDescriptor(
        value: CollaborationDescriptor, discovery: ValidatedDiscovery, coreIdentity: CoreIdentity,
        environment: EnvironmentTrust, provenance: DescriptorProvenance
    ): ValidatedDescriptor = ValidatedDescriptor.validate(value, discovery, coreIdentity, environment, provenance)

    /** Registered profile comparison only; returned queries, PKCE and state require the future adapter. */
    fun validateCallback(value: String, hop: CallbackHop, environment: EnvironmentTrust) {
        val expected = when (hop) {
            CallbackHop.CORE -> environment.redirectUri
            CallbackHop.MATRIX -> environment.matrixRedirectUri
        }
        fun refuse(): Nothing = throw DomainFailure(DomainError.CALLBACK_MISMATCH)
        if (value != expected || environment.redirectUri == environment.matrixRedirectUri ||
            !isVisibleASCII(value) || '%' in value || '\\' in value) refuse()
        val uri = try { URI(value) } catch (_: URISyntaxException) { refuse() }
        val scheme = uri.scheme ?: refuse()
        val path = uri.rawPath ?: refuse()
        if (scheme.isEmpty() || scheme.any { it in 'A'..'Z' } ||
            scheme in setOf("http", "file", "javascript", "data") || uri.rawUserInfo != null ||
            uri.port != -1 || uri.rawQuery != null || uri.rawFragment != null || !path.startsWith('/')) refuse()
        if (scheme == "https" && (uri.host == null || !validDNSName(uri.rawAuthority ?: ""))) refuse()
    }

    fun isVisibleASCII(value: String): Boolean = value.all { it.code in 33..126 }

    fun canonicalUUID(value: String): Boolean = value.length == 36 && value.withIndex().all { (index, char) ->
        if (index == 8 || index == 13 || index == 18 || index == 23) char == '-'
        else char in '0'..'9' || char in 'a'..'f'
    }

    /** Entity and session correlation IDs must carry an actual non-nil identifier. */
    fun canonicalNonNilUUID(value: String): Boolean = canonicalUUID(value) &&
        value != "00000000-0000-0000-0000-000000000000"

    /** Preserve the local 256-byte scope bound without accepting malformed scalar text. */
    internal fun boundedScopeChannelId(value: String): Boolean = boundedScalarText(value, requireTrimmed = true)

    /** Bounded visible labels retain exact scalar text, never replacement-encoded surrogates. */
    internal fun boundedScalarText(value: String, requireTrimmed: Boolean): Boolean {
        if (value.length !in 1..256 || value.isBlank() || (requireTrimmed && value != value.trim())) return false
        var offset = 0
        while (offset < value.length) {
            val char = value[offset]
            val point = Character.codePointAt(value, offset)
            if (Character.isISOControl(point) || Character.getType(point) == Character.FORMAT.toInt() ||
                point == 0x2028 || point == 0x2029) return false
            if (char.isHighSurrogate()) {
                if (offset + 1 >= value.length || !value[offset + 1].isLowSurrogate()) return false
                offset += 2
            } else {
                if (char.isLowSurrogate()) return false
                offset++
            }
        }
        return value.toByteArray(Charsets.UTF_8).size <= 256
    }

    fun canonicalSlug(value: String): Boolean = value.length in 5..20 &&
        (value.first() in 'a'..'z' || value.first() in '0'..'9') &&
        (value.last() in 'a'..'z' || value.last() in '0'..'9') &&
        value.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }

    internal fun validDNSName(value: String): Boolean {
        if (value.isEmpty() || value.length > 253 || value.none { it in 'a'..'z' }) return false
        val labels = value.split('.')
        if (labels.size < 2) return false
        val numericHost = labels.all { label ->
            if (label.startsWith("0x")) {
                val digits = label.drop(2)
                digits.isNotEmpty() && digits.all { it in '0'..'9' || it in 'a'..'f' }
            } else label.isNotEmpty() && label.all { it in '0'..'9' }
        }
        if (numericHost) return false
        return labels.all { label ->
            label.length in 1..63 && label.first() != '-' && label.last() != '-' &&
                label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }
        }
    }
}

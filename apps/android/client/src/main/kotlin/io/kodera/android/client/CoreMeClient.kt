package io.kodera.android.client

import io.kodera.android.domain.TrustPolicy
import okhttp3.Response

data class MemberOrganisation(val id: String, val slug: String, val name: String, val realm: String?,
    val role: String, val state: String)

/** The fields of Core's `Me` this client shows. Everything else in the response is ignored. */
data class MemberProfile(val id: String, val email: String, val displayName: String?,
    val organisations: List<MemberOrganisation>) {
    /** The membership whose realm is the one the session signed into. */
    fun organisation(realm: String): MemberOrganisation? = organisations.firstOrNull { it.realm == realm }
}

sealed interface MeFailure {
    data object ProtocolViolation : MeFailure
    data object Forbidden : MeFailure
    data object ServiceUnavailable : MeFailure
    data object IdentityUnavailable : MeFailure
    data class Transport(val reason: TransportFailure) : MeFailure
}

sealed interface MeOutcome {
    data class Member(val profile: MemberProfile) : MeOutcome
    /** The session ended: Core refused a freshly refreshed token, or the refresh itself was refused. */
    data object SignedOut : MeOutcome
    data class Unavailable(val failure: MeFailure) : MeOutcome
}

/**
 * `GET /api/v1/me` through the session's [CoreRequester], which owns the Core origin, the bearer, the
 * 401 and 403 policy and the transport, and is closed by its owner. This client only maps Core's answer
 * to what the app shows. [fetch] blocks; call it off the main thread.
 */
class CoreMeClient(private val requester: CoreRequester) {
    fun fetch(): MeOutcome = when (val reply = requester.get("/api/v1/me", this::read)) {
        is CoreReply.Answered -> reply.value
        CoreReply.Forbidden -> MeOutcome.Unavailable(MeFailure.Forbidden)
        CoreReply.SignedOut -> MeOutcome.SignedOut
        CoreReply.IdentityUnavailable -> MeOutcome.Unavailable(MeFailure.IdentityUnavailable)
        CoreReply.Unsendable, CoreReply.PathRefused -> MeOutcome.Unavailable(MeFailure.ProtocolViolation)
        is CoreReply.Transport -> MeOutcome.Unavailable(MeFailure.Transport(reply.reason))
    }

    private fun read(response: Response): MeOutcome {
        return when (response.code) {
            200 -> {
                val body = CoreRequester.bounded(response.body.byteStream())
                    ?: return MeOutcome.Unavailable(MeFailure.ProtocolViolation)
                try { MeOutcome.Member(decode(body)) }
                catch (_: DiscoveryDecodingException) { MeOutcome.Unavailable(MeFailure.ProtocolViolation) }
            }
            429, in 500..599 -> MeOutcome.Unavailable(MeFailure.ServiceUnavailable)
            // Redirects are never followed, so a bearer token cannot reach another origin.
            else -> MeOutcome.Unavailable(MeFailure.ProtocolViolation)
        }
    }

    internal companion object {
        fun decode(data: ByteArray): MemberProfile {
            val root = StrictJson.parse(data).objectValue()
            val id = root["id"]?.stringValue() ?: refused()
            val email = root["email"]?.stringValue() ?: refused()
            val entries = root["organisations"]?.arrayValue() ?: refused()
            // Core validates the address; here it only has to be one, to show as a fallback name.
            if (!TrustPolicy.canonicalNonNilUUID(id) || email.isBlank() || '@' !in email || entries.size > 100) refused()
            // An empty display name is no name: the email is shown instead.
            val displayName = root["display_name"]?.takeUnless { it == JsonValue.NullValue }?.stringValue()?.takeUnless { it.isEmpty() }
            if (displayName != null && displayName.scalarCount() > 200) refused()
            val organisations = entries.map { entry ->
                val membership = entry.objectValue()
                val organisation = membership["organisation"]?.objectValue() ?: refused()
                val orgId = organisation["id"]?.stringValue() ?: refused()
                val slug = organisation["slug"]?.stringValue() ?: refused()
                val name = organisation["name"]?.stringValue() ?: refused()
                val role = membership["role"]?.stringValue() ?: refused()
                val state = membership["state"]?.stringValue() ?: refused()
                if (!TrustPolicy.canonicalNonNilUUID(orgId) || !TrustPolicy.canonicalSlug(slug) || name.scalarCount() !in 1..200 ||
                    role.isEmpty() || role.length > 64 || state.isEmpty() || state.length > 64) refused()
                val realm = organisation["realm"]?.takeUnless { it == JsonValue.NullValue }?.stringValue()
                if (realm != null && realm.toByteArray(Charsets.UTF_8).size > 64) refused()
                MemberOrganisation(orgId, slug, name, realm, role, state)
            }
            return MemberProfile(id, email, displayName, immutableCopy(organisations))
        }
    }
}

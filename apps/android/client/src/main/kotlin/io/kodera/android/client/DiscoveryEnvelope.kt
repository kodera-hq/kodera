package io.kodera.android.client

import io.kodera.android.domain.DiscoverySelection
import io.kodera.android.domain.TrustPolicy
import java.util.Collections

/** Anonymous public metadata; no authenticated identity or membership is represented. */
data class AnonymousOrganisationMetadata(val organisationId: String, val organisationSlug: String,
    val displayName: String, val realm: String, val issuer: String, val openidConfigurationUrl: String)
sealed interface AnonymousDiscoveryResult {
    data object NoMatch : AnonymousDiscoveryResult
    data class Single(val metadata: AnonymousOrganisationMetadata) : AnonymousDiscoveryResult
    data class Multiple(val choices: List<AnonymousOrganisationMetadata>) : AnonymousDiscoveryResult
}
internal fun <T> immutableCopy(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
object DiscoveryEnvelope {
    fun decode(data: ByteArray, configuration: CoreDiscoveryConfiguration): AnonymousDiscoveryResult {
        val root = StrictJson.parse(data).objectValue()
        if (root.keys != setOf("realm", "issuer", "openid_configuration_url", "organisation", "candidates")) refused()
        val candidates = root.getValue("candidates").arrayValue()
        val emptyMetadata = listOf("realm", "issuer", "openid_configuration_url", "organisation").all { root[it] == JsonValue.NullValue }
        if (emptyMetadata) {
            if (candidates.isEmpty()) return AnonymousDiscoveryResult.NoMatch
            if (candidates.size !in 2..20) refused()
            val values = candidates.map { candidate ->
                val fields = candidate.objectValue()
                if (fields.keys != setOf("realm", "issuer", "openid_configuration_url", "organisation")) refused()
                metadata(fields, configuration)
            }
            if (values.map { it.organisationId }.toSet().size != values.size) refused()
            for ((before, after) in values.zipWithNext()) {
                if (!(before.organisationSlug < after.organisationSlug ||
                    (before.organisationSlug == after.organisationSlug && before.organisationId < after.organisationId))) refused()
            }
            return AnonymousDiscoveryResult.Multiple(immutableCopy(values))
        }
        if (candidates.isNotEmpty()) refused()
        return AnonymousDiscoveryResult.Single(metadata(root, configuration))
    }
    private fun metadata(fields: Map<String, JsonValue>, configuration: CoreDiscoveryConfiguration): AnonymousOrganisationMetadata {
        val realm = fields["realm"]?.stringValue() ?: refused()
        val issuer = fields["issuer"]?.stringValue() ?: refused()
        val wellKnown = fields["openid_configuration_url"]?.stringValue() ?: refused()
        val organisation = fields["organisation"]?.objectValue() ?: refused()
        if (organisation.keys != setOf("id", "slug", "name", "realm")) refused()
        val id = organisation.getValue("id").stringValue(); val slug = organisation.getValue("slug").stringValue()
        val name = organisation.getValue("name").stringValue()
        if (name.scalarCount() !in 1..200 || organisation.getValue("realm").stringValue() != realm) refused()
        try { TrustPolicy.validateDiscovery(DiscoverySelection(id, slug, realm, issuer, wellKnown), configuration.trust) }
        catch (_: io.kodera.android.domain.DomainFailure) { refused() }
        return AnonymousOrganisationMetadata(id, slug, name, realm, issuer, wellKnown)
    }
    /**
     * `RealmDiscoveryRequest.email` at `contracts/v0.26.0`, verbatim: a bounded ASCII local part, then a dotted
     * DNS domain. Core refuses anything else with 422, so the client sends nothing else.
     */
    private val emailPattern = Regex(
        "^(?=[^@]{1,64}@)[A-Za-z0-9!#${'$'}%&'*+\\-/=?^_`{|}~]+(?:\\.[A-Za-z0-9!#${'$'}%&'*+\\-/=?^_`{|}~]+)*@" +
            "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![\\s\\S])"
    )
    internal fun approvedEmail(value: String): Boolean =
        value.length in 1..254 && value.all { it.code in 33..126 } && emailPattern.matches(value)
    internal fun canonicalSlug(value: String): Boolean {
        fun alphaNumeric(c: Char) = c in 'a'..'z' || c in '0'..'9'
        return value.length in 5..20 && alphaNumeric(value.first()) && alphaNumeric(value.last()) && value.all { alphaNumeric(it) || it == '-' }
    }
}

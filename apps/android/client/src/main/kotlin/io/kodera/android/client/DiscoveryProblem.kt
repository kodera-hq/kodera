package io.kodera.android.client

import java.util.Locale

data class RetryHint(val seconds: Long)
data class ProblemCorrelation(val requestId: String)
enum class TransportFailure { TIMEOUT, OFFLINE, TLS, AUTHENTICATION_CHALLENGE, OTHER }
/**
 * Why Core refused a discovery request, one value per problem type `discoverRealm` documents for it. Each is
 * final for that request: none is retried, and the entry screen shows "request refused".
 */
enum class RequestRejection {
    /** 400 `malformed-request`: unparseable JSON, duplicate keys, or an invalid compatibility key. */
    MALFORMED_REQUEST,
    /** 400 `idempotency-key-missing`: the compatibility key was not sent. */
    IDEMPOTENCY_KEY_MISSING,
    /** 403 `forbidden`: refused from a browser's `Origin` or `Sec-Fetch-Site`, which a native request never sends. */
    FORBIDDEN,
    /** 413 `payload-too-large`: the body is over 4096 bytes. */
    PAYLOAD_TOO_LARGE,
    /** 415 `unsupported-media-type`: the body is not `application/json`. */
    UNSUPPORTED_MEDIA_TYPE,
    /** 422 `validation-error`: not exactly one canonical slug or approved email. */
    VALIDATION_ERROR,
}
sealed interface DiscoveryFailure {
    data object NotConfigured : DiscoveryFailure
    data object InvalidInput : DiscoveryFailure
    data object ProtocolViolation : DiscoveryFailure
    data object UnsupportedService : DiscoveryFailure
    data class RejectedRequest(val reason: RequestRejection) : DiscoveryFailure
    data class Transport(val reason: TransportFailure) : DiscoveryFailure
    data class RateLimited(val hint: RetryHint, val correlation: ProblemCorrelation) : DiscoveryFailure
    data class TemporarilyUnavailable(val hint: RetryHint, val correlation: ProblemCorrelation) : DiscoveryFailure
    data class InternalServiceError(val correlation: ProblemCorrelation) : DiscoveryFailure
}
sealed interface AnonymousDiscoveryOutcome {
    data class Result(val value: AnonymousDiscoveryResult) : AnonymousDiscoveryOutcome
    data class Failure(val failure: DiscoveryFailure) : AnonymousDiscoveryOutcome
    data object Cancelled : AnonymousDiscoveryOutcome
}
class DiscoveryDecodingException(val failure: DiscoveryFailure = DiscoveryFailure.ProtocolViolation) : Exception("Discovery response refused")
object DiscoveryProblem {
    internal fun validateHeaders(input: List<Pair<String, String>>, problem: Boolean): Map<String, String> {
        val headers = linkedMapOf<String, String>()
        for ((name, value) in input) {
            val key = name.lowercase(Locale.ROOT)
            if (headers.containsKey(key)) refused()
            headers[key] = value
        }
        val media = headers["content-type"]?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
        val policies = headers["cache-control"]?.split(',')?.map { it.trim().lowercase(Locale.ROOT) } ?: emptyList()
        if (media != (if (problem) "application/problem+json" else "application/json") || "no-store" !in policies ||
            !validRequestId(headers["x-request-id"] ?: "")) refused()
        val encoding = headers["content-encoding"]
        if (encoding != null && !encoding.trim().equals("identity", ignoreCase = true)) refused()
        return headers
    }
    fun decode(data: ByteArray, status: Int, headers: List<Pair<String, String>>): DiscoveryFailure {
        val canonical = validateHeaders(headers, true)
        val fields = StrictJson.parse(data).objectValue()
        val type = fields["type"]?.stringValue() ?: refused()
        val title = fields["title"]?.stringValue() ?: refused()
        val requestId = fields["request_id"]?.stringValue() ?: refused()
        if (title.scalarCount() > 200 || status !in 100..599 || fields["status"]?.integerValue() != status.toLong() ||
            !validRequestId(requestId) || requestId != canonical["x-request-id"]) refused()
        validateOptional(fields)
        val prefix = "https://kodera.io/problems/"
        if (!type.startsWith(prefix)) refused()
        val category = type.removePrefix(prefix)
        val correlation = ProblemCorrelation(requestId)
        val rejection = when (status to category) {
            400 to "malformed-request" -> RequestRejection.MALFORMED_REQUEST
            400 to "idempotency-key-missing" -> RequestRejection.IDEMPOTENCY_KEY_MISSING
            403 to "forbidden" -> RequestRejection.FORBIDDEN
            413 to "payload-too-large" -> RequestRejection.PAYLOAD_TOO_LARGE
            415 to "unsupported-media-type" -> RequestRejection.UNSUPPORTED_MEDIA_TYPE
            422 to "validation-error" -> RequestRejection.VALIDATION_ERROR
            else -> null
        }
        if (rejection != null) return DiscoveryFailure.RejectedRequest(rejection)
        if (status == 500 && category == "internal-error") return DiscoveryFailure.InternalServiceError(correlation)
        if ((status == 429 && category == "rate-limited") || (status == 503 && category == "service-unavailable")) {
            val seconds = fields["retry_after_s"]?.integerValue() ?: refused()
            val raw = canonical["retry-after"] ?: refused()
            if (seconds <= 0 || raw.isEmpty() || raw.any { it !in '0'..'9' } || raw.toLongOrNull() != seconds || (status == 503 && seconds != 5L)) refused()
            return if (status == 429) DiscoveryFailure.RateLimited(RetryHint(seconds), correlation)
                else DiscoveryFailure.TemporarilyUnavailable(RetryHint(seconds), correlation)
        }
        refused()
    }
    private fun validRequestId(value: String) = value.isNotEmpty() && value.length <= 64 && value.all { it.code in 33..126 }
    private fun validateOptional(fields: Map<String, JsonValue>) {
        for ((name, bound) in listOf("detail" to 2000, "reason" to 100)) fields[name]?.let { if (it.stringValue().scalarCount() > bound) refused() }
        for (name in listOf("instance", "first_seen_at")) fields[name]?.stringValue()
        val uuid = Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
        for (name in listOf("job_id", "organisation_id")) fields[name]?.let { if (it != JsonValue.NullValue && !uuid.matches(it.stringValue())) refused() }
        fields["current_etag"]?.let { if (it != JsonValue.NullValue) it.stringValue() }
        fields["retry_after_s"]?.let { if (it != JsonValue.NullValue && it.integerValue() < 0) refused() }
        // `payload-too-large` names the endpoint's limit; it is a count of bytes when present.
        fields["limit_bytes"]?.let { if (it.integerValue() < 0) refused() }
        for (name in listOf("allowed_states", "required_amr")) fields[name]?.arrayValue()?.forEach {
            val text = it.stringValue(); if (name == "required_amr" && text.scalarCount() > 128) refused()
        }
        fields["errors"]?.arrayValue()?.forEach {
            val error = it.objectValue(); error["pointer"]?.stringValue() ?: refused()
            if ((error["code"]?.stringValue() ?: refused()).scalarCount() > 100) refused()
            error["detail"]?.let { text -> if (text.stringValue().scalarCount() > 500) refused() }
        }
        // Unknown extensions remain bounded parsed values and are deliberately discarded.
    }
}

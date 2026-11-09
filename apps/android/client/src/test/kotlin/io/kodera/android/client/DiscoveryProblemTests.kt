package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test

class DiscoveryProblemTests {
    private fun decode(status: Int, type: String, retry: String? = null, header: String? = null): DiscoveryFailure =
        DiscoveryProblem.decode(Fixtures.problem(status, type, retry), status, Fixtures.headers(true) + (header?.let { listOf("Retry-After" to it) } ?: emptyList()))
    @Test fun testContractedStatusTypeAndSafeCorrelationMapping() {
        for ((status, type, reason) in listOf(Triple(400, "malformed-request", RequestRejection.MALFORMED_REQUEST),
            Triple(400, "idempotency-key-missing", RequestRejection.IDEMPOTENCY_KEY_MISSING), Triple(403, "forbidden", RequestRejection.FORBIDDEN),
            Triple(413, "payload-too-large", RequestRejection.PAYLOAD_TOO_LARGE), Triple(415, "unsupported-media-type", RequestRejection.UNSUPPORTED_MEDIA_TYPE),
            Triple(422, "validation-error", RequestRejection.VALIDATION_ERROR))) assertEquals(type, DiscoveryFailure.RejectedRequest(reason), decode(status, type))
        // A documented type under another status is not that problem.
        for ((status, type) in listOf(400 to "forbidden", 403 to "malformed-request", 422 to "payload-too-large")) Fixtures.refused { decode(status, type) }
        assertEquals(DiscoveryFailure.InternalServiceError(ProblemCorrelation(Fixtures.REQUEST_ID)), decode(500, "internal-error"))
        Fixtures.refused { decode(400, "unknown") }
    }
    @Test fun testStatusAndRequestIdDisagreementRefuses() {
        val body = Fixtures.problem()
        Fixtures.refused { DiscoveryProblem.decode(body, 422, Fixtures.headers(true)) }
        Fixtures.refused { DiscoveryProblem.decode(body, 400, Fixtures.headers(true).map { if (it.first == "X-Request-Id") it.first to "different" else it }) }
        for (id in listOf("", "a".repeat(65), "line\n")) {
            val bytes = body.toString(Charsets.UTF_8).replace(Fixtures.REQUEST_ID, id).toByteArray()
            Fixtures.refused { DiscoveryProblem.decode(bytes, 400, Fixtures.headers(true).map { if (it.first == "X-Request-Id") it.first to id else it }) }
        }
        for (field in listOf("type", "title", "status", "request_id")) {
            val obj = com.google.gson.JsonParser.parseString(body.toString(Charsets.UTF_8)).asJsonObject; obj.remove(field)
            Fixtures.refused { DiscoveryProblem.decode(Fixtures.bytes(obj), 400, Fixtures.headers(true)) }
        }
    }
    @Test fun testProblemProseAndExtensionsNeverEnterPublicResult() {
        val failure = decode(500, "internal-error"); assertFalse(failure.toString().contains("PRIVATE"))
        val obj = com.google.gson.JsonParser.parseString(Fixtures.problem().toString(Charsets.UTF_8)).asJsonObject
        obj.add("future_extension", com.google.gson.JsonParser.parseString("""{"ignored":"PRIVATE DETAIL SENTINEL"}"""))
        assertEquals(DiscoveryFailure.RejectedRequest(RequestRejection.MALFORMED_REQUEST), DiscoveryProblem.decode(Fixtures.bytes(obj), 400, Fixtures.headers(true)))
        val invalid = listOf("detail" to "[]", "reason" to "true", "instance" to "1", "first_seen_at" to "false", "job_id" to "\"bad\"", "organisation_id" to "42", "current_etag" to "true", "required_amr" to "[true]", "allowed_states" to "[1]", "errors" to "[{\"pointer\":1,\"code\":\"bad\"}]")
        for ((key, value) in invalid) {
            val mutated = obj.deepCopy(); mutated.add(key, com.google.gson.JsonParser.parseString(value))
            Fixtures.refused { DiscoveryProblem.decode(Fixtures.bytes(mutated), 400, Fixtures.headers(true)) }
        }
        val duplicateExtension = Fixtures.problem().toString(Charsets.UTF_8).dropLast(1) + ",\"future\":{\"a\":1,\"\\u0061\":2}}"
        Fixtures.refused { DiscoveryProblem.decode(duplicateExtension.toByteArray(), 400, Fixtures.headers(true)) }
    }
    @Test fun testRateLimitAndUnavailableRetryHints() {
        assertEquals(DiscoveryFailure.RateLimited(RetryHint(1), ProblemCorrelation(Fixtures.REQUEST_ID)), decode(429, "rate-limited", "1", "1"))
        assertEquals(DiscoveryFailure.TemporarilyUnavailable(RetryHint(5), ProblemCorrelation(Fixtures.REQUEST_ID)), decode(503, "service-unavailable", "5", "5"))
    }
    @Test fun testRetryHintTokensMismatchAndOverflowRefuse() {
        for ((body, header) in listOf("0" to "0", "-1" to "-1", "1.5" to "1.5", "true" to "1", "null" to "1", "2" to "1", "1e0" to "1", "1" to "+1", "9223372036854775808" to "9223372036854775808")) Fixtures.refused { decode(429, "rate-limited", body, header) }
        Fixtures.refused { decode(429, "rate-limited") }
    }
    @Test fun testServiceUnavailableRequiresExactDelayFive() {
        assertEquals(DiscoveryFailure.TemporarilyUnavailable(RetryHint(5), ProblemCorrelation(Fixtures.REQUEST_ID)), decode(503, "service-unavailable", "5", "5"))
        for (hint in listOf("4", "6")) Fixtures.refused { decode(503, "service-unavailable", hint, hint) }
    }
}

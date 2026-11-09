package io.kodera.android.client

import org.junit.Assert.assertEquals
import org.junit.Test

class ProblemRetryMinimumTests {
    @Test fun testOptionalRetryMinimumAppliesToEveryProblem() {
        for (retry in listOf("0", "null")) {
            assertEquals("Non-rate Problem permits zero or null advisory retry",
                DiscoveryFailure.RejectedRequest(RequestRejection.MALFORMED_REQUEST),
                DiscoveryProblem.decode(Fixtures.problem(400, "malformed-request", retry),
                    400, Fixtures.headers(true)))
        }
        val negative = try {
            DiscoveryProblem.decode(Fixtures.problem(400, "malformed-request", "-1"),
                400, Fixtures.headers(true))
        } catch (error: DiscoveryDecodingException) {
            error.failure
        }
        assertEquals("Shared Problem minimum applies outside rate-limit/service-unavailable statuses",
            DiscoveryFailure.ProtocolViolation, negative)
    }
}

package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test

class NativeCallWakeDataTests {
    private val data = mapOf(
        "call_id" to "11111111-1111-4111-8111-111111111111",
        "organisation_id" to "22222222-2222-4222-8222-222222222222",
        "channel_id" to "33333333-3333-4333-8333-333333333333",
        "epoch" to "1", "state" to "ringing", "expires_at" to "130",
    )

    @Test fun oversizedAndNoncanonicalNumbersAreDiscardedWithoutThrowing() {
        for (key in listOf("epoch", "expires_at")) {
            for (value in listOf("99999999999999999999999999999999", "-99999999999999999999999999999999", "01", "+1", "1.0", "", " 1")) {
                assertNull(NativeCallWakeData.admit(data + (key to value), 100))
            }
        }
        assertNotNull(NativeCallWakeData.admit(data, 100))
        assertNull(NativeCallWakeData.admit(data + ("extra" to "value"), 100))
        assertNull(NativeCallWakeData.admit(data - "epoch", 100))
    }
}

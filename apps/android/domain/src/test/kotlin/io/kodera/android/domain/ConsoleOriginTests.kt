package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Console action's destination: exactly the configured origin, validated like the other origins. */
class ConsoleOriginTests {
    @Test fun testTheUrlIsExactlyTheConfiguredOrigin() {
        for (policy in LoopbackPolicy.entries) {
            assertEquals("https://console.kodera.test", ConsoleOrigin.admit("https://console.kodera.test", policy))
        }
    }

    @Test fun testAnUnsetOriginOffersNoConsoleAction() {
        for (policy in LoopbackPolicy.entries) assertNull(ConsoleOrigin.admit("", policy))
    }

    @Test fun testAReleasePolicyRefusesAnHttpOrigin() {
        for (origin in listOf("http://localhost:5173", "http://127.0.0.1:5173", "http://console.kodera.test")) {
            assertNull(origin, ConsoleOrigin.admit(origin, LoopbackPolicy.REFUSE))
        }
    }

    /** The release refusal is not vacuous: a debug build admits loopback, and only loopback, over HTTP. */
    @Test fun testADevelopmentPolicyAdmitsLoopbackOnly() {
        assertEquals("http://localhost:5173", ConsoleOrigin.admit("http://localhost:5173", LoopbackPolicy.ADMIT_FOR_DEVELOPMENT))
        assertNull(ConsoleOrigin.admit("http://console.kodera.test", LoopbackPolicy.ADMIT_FOR_DEVELOPMENT))
    }

    @Test fun testAnythingButABareOriginIsRefused() {
        for (value in listOf("https://console.kodera.test/", "https://console.kodera.test/claim", "https://console.kodera.test?x=1",
                "https://console.kodera.test#x", "https://user@console.kodera.test", " https://console.kodera.test",
                "https://console.kodera.test:8443", "HTTPS://console.kodera.test", "console.kodera.test")) {
            assertNull(value, ConsoleOrigin.admit(value, LoopbackPolicy.ADMIT_FOR_DEVELOPMENT))
        }
    }
}

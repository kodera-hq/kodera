package io.kodera.android.session

import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.LoopbackAwareConnections
import io.kodera.android.auth.SIGN_IN_BROWSERS
import io.kodera.android.auth.appAuthConfiguration
import io.kodera.android.auth.url
import io.kodera.android.domain.LoopbackPolicy
import net.openid.appauth.browser.BrowserDescriptor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * The Console opens in the browser AppAuth's selector picks for sign-in, at exactly the configured origin.
 * The selection and `startActivity` themselves need a device and are not run here.
 */
class ConsoleRequestTests {
    private val console = url(ConnectionPolicy.HTTPS, "console.kodera.test")

    /** Owned by `ConsoleRequest.of`: the Console intent carries the package of the browser selected for sign-in. */
    @Test fun testTheConsoleIntentCarriesTheSelectedBrowsersPackage() {
        val selected = BrowserDescriptor("org.example.browser", emptySet(), "1.0", true)
        val request = ConsoleRequest.of(console, selected)
        assertEquals("org.example.browser", request.browserPackage)
        assertEquals(console, request.origin)
    }

    /** Only when no browser is found: the plain browsable intent, with no package, which Android resolves. */
    @Test fun testWithNoBrowserFoundTheIntentNamesNoPackage() {
        val request = ConsoleRequest.of(console, null)
        assertNull(request.browserPackage)
        assertEquals(console, request.origin)
    }

    /** Sign-in and the Console select their browser with the one matcher, so they pick the same browser. */
    @Test fun testSignInSelectsItsBrowserWithTheConsolesMatcher() {
        for (loopback in LoopbackPolicy.entries) {
            val configuration = appAuthConfiguration(loopback, LoopbackAwareConnections(loopback))
            assertSame("$loopback", SIGN_IN_BROWSERS, configuration.browserMatcher)
        }
    }
}

package io.kodera.android.session

import io.kodera.android.auth.LoopbackAwareConnections
import io.kodera.android.auth.SIGN_IN_BROWSERS
import io.kodera.android.auth.appAuthConfiguration
import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Sign-in is the only page the app opens in a browser, and it selects that browser with one matcher.
 * The app has no Console request any more: it links to no commercial page.
 */
class SignInBrowserTests {
    @Test fun testSignInSelectsItsBrowserWithTheOneMatcher() {
        for (loopback in LoopbackPolicy.entries) {
            val configuration = appAuthConfiguration(loopback, LoopbackAwareConnections(loopback))
            assertSame("$loopback", SIGN_IN_BROWSERS, configuration.browserMatcher)
        }
    }
}

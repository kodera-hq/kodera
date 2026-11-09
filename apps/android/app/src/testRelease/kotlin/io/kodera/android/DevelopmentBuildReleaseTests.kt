package io.kodera.android

import io.kodera.android.auth.AppAuthChecks
import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.url
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.entry.BuildValues
import io.kodera.android.entry.DeploymentConfiguration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Runs against the release source set only (`testReleaseUnitTest`): a release build never admits
 * plain-HTTP loopback and carries no development issuer, whatever local.properties says.
 */
class DevelopmentBuildReleaseTests {
    @Test fun testAReleaseBuildRefusesLoopbackAndHasNoDevelopmentIssuer() {
        assertEquals(LoopbackPolicy.REFUSE, DevelopmentBuild.loopback)
        assertEquals("", DevelopmentBuild.developmentIssuer)
        assertFalse(AppAuthChecks.skipIssuerHttpsCheck(DevelopmentBuild.loopback))
        assertFalse(ConnectionPolicy.admits("http", "localhost:8080", DevelopmentBuild.loopback))
    }

    @Test fun testAReleaseBuildGivenLoopbackValuesIsUnconfigured() {
        val local = url("http", "localhost:8080")
        val deployment = DeploymentConfiguration.read(BuildValues(url("http", "localhost:8000"), local, "app-client",
            "true", "$local/realms/kodera-dev", url("http", "localhost:5173")))
        assertNull(deployment.signIn)
        assertNull(deployment.discovery)
        assertNull(deployment.coreApiOrigin)
        assertNull(deployment.developmentIssuer)
        assertNull(deployment.consoleOrigin)
    }

    /** The same reading is not vacuous: HTTPS values configure a release build. */
    @Test fun testAReleaseBuildGivenHttpsValuesIsConfigured() {
        val deployment = DeploymentConfiguration.read(BuildValues(url("https", "core.kodera.test"),
            url("https", "id.kodera.test"), "app-client", "", "", url("https", "console.kodera.test")))
        assertNotNull(deployment.signIn)
        assertNotNull(deployment.coreApiOrigin)
        assertEquals(listOf("openid"), deployment.signIn?.scopes)
        assertEquals(url("https", "console.kodera.test"), deployment.consoleOrigin)
    }

    /** A release build refuses a plain-HTTP Console origin, loopback or not, and an unset one offers none. */
    @Test fun testAReleaseBuildRefusesAnHttpConsoleOrigin() {
        val values = { console: String -> BuildValues(url("https", "core.kodera.test"), url("https", "id.kodera.test"),
            "app-client", "", "", console) }
        for (console in listOf(url("http", "localhost:5173"), url("http", "console.kodera.test"), "")) {
            val deployment = DeploymentConfiguration.read(values(console))
            assertNotNull(console, deployment.signIn)
            assertNull(console, deployment.consoleOrigin)
        }
    }
}

package io.kodera.android

import io.kodera.android.auth.url
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.entry.BuildValues
import io.kodera.android.entry.DeploymentConfiguration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** The debug counterpart of DevelopmentBuildReleaseTests: the local realm, and the offline-access switch. */
class DevelopmentBuildDebugTests {
    @Test fun testADebugBuildAdmitsLoopback() {
        assertEquals(LoopbackPolicy.ADMIT_FOR_DEVELOPMENT, DevelopmentBuild.loopback)
    }

    @Test fun testADebugBuildReachesTheLocalRealmAndRequestsOfflineAccessWhenAsked() {
        val local = url("http", "localhost:8080")
        val values = { offline: String -> BuildValues(url("http", "localhost:8000"), local, "app-client", offline,
            "$local/realms/kodera-dev", url("http", "localhost:5173")) }
        val on = DeploymentConfiguration.read(values("true"))
        assertEquals("$local/realms/kodera-dev", on.developmentIssuer)
        assertEquals(url("http", "localhost:5173"), on.consoleOrigin)
        assertNotNull(on.discovery)
        assertEquals(listOf("openid", "offline_access"), on.signIn?.scopes)
        assertEquals(listOf("openid"), DeploymentConfiguration.read(values("")).signIn?.scopes)
    }
}

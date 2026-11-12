package io.kodera.android.entry

import io.kodera.android.BuildConfig
import io.kodera.android.DevelopmentBuild
import io.kodera.android.client.CoreDiscoveryConfiguration
import io.kodera.android.client.SignInConfiguration
import io.kodera.android.client.SignInException
import io.kodera.android.domain.ConsoleOrigin
import io.kodera.android.domain.DomainFailure
import io.kodera.android.domain.IssuerAdmission

/** What this build may talk to. Every field is null when the build does not supply it. */
internal class Deployment(
    val discovery: CoreDiscoveryConfiguration?,
    val signIn: SignInConfiguration?,
    val coreApiOrigin: String?,
    /** Debug builds only: a realm issuer to sign in to without Core discovery. */
    val developmentIssuer: String?,
    /** The validated Console origin, or null. Held only: no screen opens it (the app links to no commercial page). */
    val consoleOrigin: String? = null,
)

/** What the build supplies, as raw text: the BuildConfig fields, or a test's. */
internal class BuildValues(
    val coreOrigin: String,
    val issuerOrigins: String,
    val clientId: String,
    val offlineAccess: String,
    val developmentIssuer: String,
    val consoleOrigin: String,
)

/**
 * Deployment values come only from Gradle properties compiled into BuildConfig (see
 * config/local.properties.example), never from form values, deep links or responses. A build
 * without them is unconfigured and says so. This file holds no value of its own.
 */
internal object DeploymentConfiguration {
    private val unconfigured = Deployment(null, null, null, null)

    fun read(): Deployment = read(BuildValues(BuildConfig.KODERA_CORE_ORIGIN, BuildConfig.KODERA_ISSUER_ORIGINS,
        BuildConfig.KODERA_CLIENT_ID, BuildConfig.KODERA_OFFLINE_ACCESS, DevelopmentBuild.developmentIssuer,
        BuildConfig.KODERA_CONSOLE_ORIGIN))

    /** Under this build's [DevelopmentBuild.loopback]: a release build admits no plain-HTTP origin here. */
    fun read(values: BuildValues): Deployment {
        val core = values.coreOrigin.trim()
        val issuerList = values.issuerOrigins.split(' ').filter { it.isNotEmpty() }
        val issuers = issuerList.toSet()
        if (core.isEmpty() || issuers.isEmpty() || issuers.size != issuerList.size) return unconfigured
        val loopback = DevelopmentBuild.loopback
        // The same origin validator as sign-in: a debug build may discover against Core on loopback.
        val discovery = try { CoreDiscoveryConfiguration.configured(core, issuers, loopback) }
            catch (_: DomainFailure) { null } catch (_: IllegalArgumentException) { null }
        val signIn = try {
            SignInConfiguration(values.clientId.trim(), issuers, loopback, SignInConfiguration.offlineAccessSetting(values.offlineAccess))
        } catch (_: SignInException) { null }
        val coreOrigin = try { IssuerAdmission.validateOrigin(core, loopback); core } catch (_: DomainFailure) { null }
        val candidate = values.developmentIssuer.trim()
        val development = if (signIn == null || candidate.isEmpty()) null
            else try { signIn.admit(candidate).issuer } catch (_: SignInException) { null }
        // The same origin validator: HTTPS, or loopback in a debug build only.
        val console = ConsoleOrigin.admit(values.consoleOrigin.trim(), loopback)
        return Deployment(discovery, signIn, coreOrigin, development, console)
    }
}

package io.kodera.android

import io.kodera.android.domain.LoopbackPolicy

/**
 * Debug builds only: plain-HTTP loopback origins and the development realm entry. The release
 * source set has its own DevelopmentBuild, which admits neither.
 */
internal object DevelopmentBuild {
    val loopback: LoopbackPolicy = LoopbackPolicy.ADMIT_FOR_DEVELOPMENT
    val developmentIssuer: String get() = BuildConfig.KODERA_DEV_ISSUER
}

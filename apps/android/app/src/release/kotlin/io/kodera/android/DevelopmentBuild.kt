package io.kodera.android

import io.kodera.android.domain.LoopbackPolicy

/** Release builds: no plain-HTTP origin and no development realm, whatever local.properties says. */
internal object DevelopmentBuild {
    val loopback: LoopbackPolicy = LoopbackPolicy.REFUSE
    val developmentIssuer: String get() = ""
}

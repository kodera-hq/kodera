import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Deployment values (Core origin, issuer origins, client ID, offline access, development issuer, Console origin) come only from
// Gradle properties: -P, ~/.gradle/gradle.properties, or the untracked local.properties (copy
// config/local.properties.example). The committed build carries none, so a build without them,
// CI's included, is unconfigured and says so on screen.
val localProperties = Properties().apply {
    rootProject.file("local.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
}
fun buildConfigString(name: String): String {
    val value = (providers.gradleProperty(name).orNull ?: localProperties.getProperty(name) ?: "").trim()
    require(value.all { it.code in 32..126 && it != '"' && it != '\\' }) { "$name holds a character a build setting cannot carry" }
    return "\"$value\""
}

android {
    namespace = "io.kodera.android"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.kodera.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "KODERA_CORE_ORIGIN", buildConfigString("kodera.coreOrigin"))
        buildConfigField("String", "KODERA_ISSUER_ORIGINS", buildConfigString("kodera.issuerOrigins"))
        buildConfigField("String", "KODERA_CLIENT_ID", buildConfigString("kodera.clientId"))
        // Exactly "true" requests offline_access. Keep release use off
        // until Keycloak #65 merged-tree proof, operator rollout and Android offline step 7 pass.
        buildConfigField("String", "KODERA_OFFLINE_ACCESS", buildConfigString("kodera.offlineAccess"))
        // Where a member with no organisation yet finishes setting up, in the browser; unset hides that action.
        buildConfigField("String", "KODERA_CONSOLE_ORIGIN", buildConfigString("kodera.consoleOrigin"))
        // AppAuth's RedirectUriReceiverActivity: the literal scheme of io.kodera.app:/oauth2redirect,
        // never derived from applicationId.
        manifestPlaceholders["appAuthRedirectScheme"] = "io.kodera.app"
    }
    buildTypes {
        getByName("debug") {
            // Read only by src/debug; the release source set has no development issuer.
            buildConfigField("String", "KODERA_DEV_ISSUER", buildConfigString("kodera.devIssuer"))
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":client"))
    implementation("net.openid:appauth:0.11.1")
    // AppAuth's own Android dependencies, declared at current stable so Dependabot tracks them;
    // AppAuth 0.11.1 alone would resolve 1.3.0 of each.
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.browser:browser:1.10.0")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    testImplementation("junit:junit:4.13.2")
}

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `java-library`
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

// The CI JDK is 21. `release` and `-Xjdk-release` compile against the JDK 17
// API itself, so a JDK 21-only call fails here instead of on a 17 runtime;
// jvmTarget alone only sets the bytecode level.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xjdk-release=17")
    }
}

tasks.withType<JavaCompile>().configureEach { options.release.set(17) }

dependencies {
    // Ed25519 for Android 8 to 12, whose platform provider has none (it arrives in API 33).
    // Only the lightweight API is used, never as a registered JCA provider.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    testImplementation("junit:junit:4.13.2")
}

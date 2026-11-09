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
    // Domain types appear in this module's public signatures.
    api(project(":domain"))
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.code.gson:gson:2.15.0")
    testImplementation("junit:junit:4.13.2")
}

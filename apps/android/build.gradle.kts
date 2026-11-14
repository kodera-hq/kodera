// Declaring the Kotlin JVM plugin here puts one Kotlin Gradle plugin version on
// the shared classpath, which is also the version AGP's built-in Kotlin uses.
plugins {
    id("com.android.application") version "9.5.1" apply false
    id("org.jetbrains.kotlin.jvm") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}

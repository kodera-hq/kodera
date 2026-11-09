# Native development

Status: Native foundation; organisation entry, AppAuth sign-in, the sealed session and the Core `/me` client are implemented. The checked-in build is unconfigured.

## Source and stack

Kotlin, Jetpack Compose and Android platform APIs, with OkHttp/Gson in the networking client and AppAuth-Android (`net.openid:appauth` 0.11.1) for sign-in. The app targets Android API 26+; exact plugin, SDK and dependency pins live in the Gradle build files.

- `domain/`: Kotlin/JVM library for trust (issuer and origin admission), session and authorization boundaries. No Android dependency.
- `client/`: Kotlin/JVM library for bounded networking (discovery, `/me`, revocation) and the sign-in session owner, its token store and the backend interface AppAuth sits behind; depends on `domain`.
- `app/`: the Android application (`io.kodera.app`), Compose UI, the AppAuth adapter and Keystore key, design tokens, fonts and catalogues; depends on `client`. `src/debug` and `src/release` each hold a `DevelopmentBuild`: only the debug one admits plain-HTTP loopback and the development realm.

## Build and test

Requirements: JDK 17 or newer (CI uses Temurin 21). The Gradle wrapper is committed; do not use another Gradle. `:domain` and `:client` need no Android SDK. `:app` needs one: set `ANDROID_HOME` or write `sdk.dir` in an untracked `local.properties`; AGP installs the pinned platform and build-tools when their licences are accepted.

```sh
./gradlew :domain:test :client:test            # JVM modules, no Android SDK needed
./gradlew :domain:test :client:test testDebugUnitTest   # the unit tests CI runs
./gradlew test assembleDebug assembleRelease   # everything (release unsigned)
```

The build does not catch drifted tokens, fonts or licences, an incomplete French/English catalogue, a widened manifest or a default deployment; this check does, and CI runs it with its self-test:

```sh
python3 scripts/ci/check-app-resources.py .
bash scripts/ci/check-app-resources.selftest.sh
```

After the build, CI also runs it with `--merged` on the merged debug manifest and `--merged-release` on the merged release manifest (`app/build/intermediates/merged_manifest/{debug,release}/`). Each refuses any permission or exported component a dependency brings outside an explicit allowlist, and a merged `<application>` that allows backup or cleartext, drops the backup rules, or names a network security configuration other than the debug loopback one (release: none). AppAuth's `RedirectUriReceiverActivity` is allowlisted as an `<activity>` (never an `<activity-alias>`, never with a `targetActivity`) with exactly VIEW, DEFAULT, BROWSABLE and the `io.kodera.app` scheme. `--merged-release` also refuses `android:debuggable` and `android:testOnly` unless absent or `"false"`. The step after it prints a summary of both manifests, pass or fail. Adding a component updates that allowlist in the same change.

That a release build admits no plain-HTTP loopback and carries no development issuer is a host test, `app/src/testRelease` (`DevelopmentBuildReleaseTests`, run by `testReleaseUnitTest`), not a source-text rule. `SessionStorageTests` ties the sealed store's path to the backup and transfer rules the same way.

`:domain` and `:client` compile with `release` 17 and `-Xjdk-release=17`, so a JDK 21-only API fails the build rather than a JDK 17 runtime.

## Configuration, local Keycloak and the emulator

Deployment values reach the app only as Gradle properties (see [native-auth.md](native-auth.md#configuration)). For local work:

```sh
cat config/local.properties.example >> local.properties   # untracked; next to sdk.dir
docker compose -f dev/keycloak/compose.yml up -d --wait   # Keycloak 26.0.7 on localhost:8080
curl http://localhost:8080/realms/kodera-dev/.well-known/openid-configuration
emulator -avd kodera-api36 &                              # or start it from Android Studio
adb wait-for-device
adb reverse tcp:8080 tcp:8080                             # the emulator's localhost:8080 is the host's
adb reverse tcp:8000 tcp:8000                             # Core, when its compose stack runs
./gradlew installDebug
```

`adb reverse` is the one way the emulator reaches the host here, so the app, the emulator's browser and the host all use `http://localhost:8080`, and Keycloak advertises the same issuer to each (and to the iOS app). Run `adb reverse` again after every emulator boot. The emulator's own `10.0.2.2` alias is not admitted: it would give Keycloak a second issuer. The compose file binds both `127.0.0.1` and `[::1]`, so `localhost` never stalls on an IPv6 attempt.

`dev/keycloak/` runs Keycloak in dev mode with the `kodera-dev` realm. Its realm file is the same as kodera-ios's, byte for byte but for its `koderaRealmSource` label: it holds the `kodera-android` and `kodera-ios` clients, configured as in every organisation realm, each with `offline_access` as its one optional scope, and one user:

- user `dev.member`, password `kodera-local-dev-only`, holding the `offline_access` realm role (mapped into both clients' scope). **Development only**: this password is public, the realm exists only inside this container, and the port is bound to loopback. Never import this realm anywhere else.
- The browser flow requires password then OTP, as in the realm template. The user has OTP as a required action, so the first sign-in asks to enrol an authenticator app, and `amr` then holds `pwd` and `otp`.
- The realm's offline sessions are configured as: idle 14 days, max 90 days, refresh tokens rotated with reuse detection. The example sets `kodera.offlineAccess=true`, so a local build requests `offline_access`; the organisation realms do not offer it yet (I-2), so a build for them leaves it unset.

kodera-ios has its own `dev/keycloak/` on the same port: run one at a time. Debug builds allow cleartext only to `localhost` and `127.0.0.1` (`app/src/debug/res/xml/debug_loopback_cleartext.xml`); a release build refuses plain HTTP before any socket opens.

A debug build with `kodera.devIssuer` set offers "Sign in to the development realm" on organisation entry, and the issuer still goes through the trust check. Organisation search needs Core discovery (I-1) on `kodera.coreOrigin`; until it runs, search reports the service unavailable. `/me` then reports "Core unavailable" unless Core's compose stack answers. Stop everything with `docker compose -f dev/keycloak/compose.yml down` and `adb emu kill`; nothing persists.

## Delivery sequence

1. Native foundation and organisation entry.
2. System-browser authorization code flow with PKCE S256 (AppAuth), protected deployment configuration and authenticated Core access. Implemented; interactive and staging proof pending.
3. Device validation of sign-in, cancellation, account switching, lifecycle and accessibility.
4. V1 text channels and audio/video, followed by release qualification and store distribution.
5. V2 collaborative Docs.

The Core and identity services have their own repositories and owners. These clients consume published contracts; they do not define provider registrations, fabricate membership or reuse Console credentials. A Core session and a future collaboration/media session are distinct.

## Interface and security

Use generated Kodera design tokens and the shared Cobalt × Kodera — givre direction. French and English product copy belongs in catalogues. Test loading, empty, cancellation and safe error states as part of each user journey. Validate actual device layouts, text scaling, screen-reader focus, keyboard/insets and platform lifecycle behavior.

Keep request ownership and cancellation explicit. Configuration must come from the protected platform configuration. Never derive service trust from form text, a deep link or an unverified response. Do not log credentials, authorization codes, tokens or raw provider errors. Sign-in uses the system browser (Custom Tabs) and the Android Keystore.

## Checks and pull requests

Repository policy checks:

```sh
python3 ../../.github/scripts/check-vendor-attribution.py ../..
python3 ../../.github/scripts/check-required-clauses.py ../..
bash ../../.github/scripts/check-vendor-attribution.selftest.sh
bash ../../.github/scripts/check-required-clauses.selftest.sh
```

Source checks, host tests, unsigned builds, simulators and physical-device tests are separate evidence classes.

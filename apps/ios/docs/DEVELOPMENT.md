# Native development

Status: Native foundation; organisation entry, AppAuth sign-in, Keychain session and the Core `/me` client are implemented.

## Source and stack

Swift 6 strict concurrency, SwiftUI, Foundation/URLSession and local Swift packages. The foundation targets iOS 16+ on iPhone and iPad.

`App/` holds the native interface, `packages/KoderaDomain/` the trust and session boundaries, `packages/KoderaClient/` bounded networking (discovery, `/me`), and `packages/KoderaAuth/` sign-in: AppAuth, the Keychain store and revocation. `project.yml` (XcodeGen) is the only project definition: `Kodera.xcodeproj` is generated and gitignored. Bundle ID `io.kodera.app`; OAuth redirect `io.kodera.app:/oauth2redirect` (see [native-auth.md](native-auth.md)).

KoderaAuth depends on AppAuth-iOS, pinned `exact:` in `Package.swift` and locked in its committed `Package.resolved`. It builds for Apple platforms only. KoderaDomain and KoderaClient have no remote dependency.

## Delivery sequence

1. Native foundation and organisation entry.
2. System-browser authorization code flow with PKCE S256 (AppAuth), protected deployment configuration and authenticated Core access. Implemented; interactive and staging proof pending.
3. Device validation of sign-in, cancellation, account switching, lifecycle and accessibility.
4. V1 text channels and audio/video, followed by release qualification and store distribution.
5. V2 collaborative Docs.

The Core and identity services have their own repositories and owners. These clients consume published contracts; they do not define provider registrations, fabricate membership or reuse Console credentials. A Core session and a future collaboration/media session are distinct.

## Interface and security

Use generated Kodera design tokens and the shared Cobalt × Kodera — givre direction. French and English product copy belongs in catalogues. Test loading, empty, cancellation and safe error states as part of each user journey. Validate actual device layouts, text scaling, screen-reader focus, keyboard/insets and platform lifecycle behavior.

Avoid SwiftUI `Binding(get:set:)` with a `String` setter: Xcode 26.6 (Swift 6.3.3) crashes in IRGen on its `@isolated(any)` setter thunk. Bind a model property instead (see `OrganisationEntryModel.slugInput`). Colour and font literals (`Color(red:)`, `#colorLiteral`, `.system(size:)`, a literal `.custom(…, size:)`) are refused outside `App/Generated/` by `check-app-resources.py`; use the generated tokens.

Keep request ownership and cancellation explicit. Configuration must come from the protected platform configuration. Never derive service trust from form text, a deep link or an unverified response. Do not log credentials, authorization codes, tokens or raw provider errors. Use the platform's system browser and secure storage when those integrations are implemented.

## Configuration and a local identity provider

Deployment values reach the app only as build settings (see [native-auth.md](native-auth.md#configuration)). For local work:

```sh
cp Config/Local.xcconfig.example Config/Local.xcconfig   # untracked; Debug builds admit loopback origins
docker compose -f dev/keycloak/compose.yml up -d --wait  # Keycloak 26.0.7 on 127.0.0.1 and [::1], port 8080
curl http://localhost:8080/realms/kodera-dev/.well-known/openid-configuration
xcodegen generate
```

`dev/keycloak/` runs Keycloak in dev mode with the `kodera-dev` realm, the same realm as kodera-android's. It holds the `kodera-ios` and `kodera-android` clients, configured as in every organisation realm plus the optional `offline_access` scope, and one user:

- user `dev.member`, password `kodera-local-dev-only`, holding the `offline_access` realm role (mapped into both clients' scope). **Development only**: this password is public, the realm exists only inside this container, and the port is bound to loopback. Never import this realm anywhere else.
- The browser flow requires password then OTP, as in the realm template. The user has OTP as a required action, so the first sign-in asks to enrol an authenticator app, and `amr` then holds `pwd` and `otp`.

Until Core discovery (I-1) runs locally, organisation search shows "unavailable". A Debug build with `KODERA_DEV_ISSUER` set offers "Sign in to the development realm" instead, and the issuer still goes through the trust check. `/me` then reports "Core unavailable" unless Core's compose stack answers on `KODERA_CORE_ORIGIN`. Stop Keycloak with `docker compose -f dev/keycloak/compose.yml down`; nothing persists.

## Checks

CI proves Xcode 26.6 on the hosted `macos-26` image; Xcode 27.1 is also used locally. [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.44.1 or later generates the project.

```sh
# Swift packages (host tests; Domain and Client also run on Linux in CI)
(cd packages/KoderaDomain && swift test --force-resolved-versions)
(cd packages/KoderaClient && swift test --force-resolved-versions)
(cd packages/KoderaAuth && swift test --force-resolved-versions)   # macOS only

# App: generate the project, then build unsigned for devices, as CI does
# (use 'generic/platform=iOS Simulator' for a simulator build)
xcodegen generate
xcodebuild -project Kodera.xcodeproj -scheme Kodera \
  -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO

# App resources and repository policy
python3 scripts/ci/check-app-resources.py .
python3 ../../.github/scripts/check-vendor-attribution.py ../..
python3 ../../.github/scripts/check-required-clauses.py ../..
```

CI (`.github/workflows/ci.yml`) runs three jobs. `Security Scan` (gitleaks and `check-app-resources.py` with its self-test) and `Swift packages (Linux)` (KoderaDomain and KoderaClient) run on every pull request and every push to `main`. `iOS app (macOS)` (unsigned Debug and Release builds for the device SDK, the tests of all three packages, and the hosted Debug App-model simulator checks below) runs only on pull requests that are not drafts. `Native CI` aggregates all three and accepts only the macOS job as skipped.

## Actual App model harness

`KoderaAppTests/AppSessionModelTests` runs the real App model, sign-in service, coordinator, requester and member/workspace parsers. Its nine cases use private finite backend/store/HTTP fixtures and unique defaults suites. Member and workspace tasks are acknowledged separately through their actual reducers; sign-in/sign-out keep internal completion handles without changing the public actions. The production initializer still constructs the same Keychain/AppAuth service, standard defaults and ordinary public requester.

Use a fresh isolated checkout without ignored deployment configuration, existing resolved dependencies and an installed simulator runtime. Never read or copy `Config/Local.xcconfig`; its presence or symlink is a stop. Every harness test command must build the independently launched host with ALL deployment values empty/off, as below. Smoke asserts its actual bundled configuration is unconfigured, so the normal host startup exits before FirstLaunch/storage work. Injected test models have separate synthetic configuration and defaults.

Local qualification may explicitly use installed Xcode 27.1; CI remains pinned to 26.6 and qualifies its own compiler, hosted imports and result schema separately. No tool/runtime/dependency installation, graph re-resolution or automatic retry is part of this harness. Use an owned result/DerivedData directory, register the heavy job, retain the disk floor plus all projected growth, and select ONE existing available Shutdown iPhone. The workflow's selector orders installed iOS runtimes by numeric version descending, then iPhones by UDID ascending; no device creation, erase or alternate destination after failure.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
test ! -e Config/Local.xcconfig && test ! -L Config/Local.xcconfig
xcodegen generate --spec project.yml
# In this NEW isolated checkout only, stage the unchanged committed lock metadata.
mkdir -p Kodera.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
cp packages/KoderaAuth/Package.resolved Kodera.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
cmp packages/KoderaAuth/Package.resolved Kodera.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
git check-ignore -v Kodera.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
# Confirm the generated destination is untracked and all paths are owned, contained and non-symlinks.
# Set A2_DEVICE_UDID to that single selected existing Shutdown iPhone.
# Set A2_RESULTS to an absolute NEW owned result path, outside tracked product files.
xcodebuild -project Kodera.xcodeproj -scheme KoderaAppTests -configuration Debug \
  -destination "platform=iOS Simulator,id=$A2_DEVICE_UDID" -destination-timeout 30 \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  -derivedDataPath "$A2_RESULTS/DerivedData" -resultBundlePath "$A2_RESULTS/run.xcresult" \
  -only-testing:KoderaAppTests/AppSessionModelTests test \
  CODE_SIGNING_ALLOWED=NO ENABLE_TESTABILITY=YES \
  KODERA_CORE_ORIGIN= KODERA_ISSUER_ORIGINS= KODERA_IOS_CLIENT_ID= \
  KODERA_DEV_ISSUER= KODERA_CONSOLE_ORIGIN= KODERA_OFFLINE_ACCESS=NO
xcrun xcresulttool get test-results summary --path "$A2_RESULTS/run.xcresult" --format json > "$A2_RESULTS/summary.json"
xcrun xcresulttool get test-results tests --path "$A2_RESULTS/run.xcresult" --format json > "$A2_RESULTS/tests.json"
```

Never copy packages, checkouts, artifacts, private configuration or old workspace metadata. Record source/destination lock hashes and byte equality; a lock schema/originHash/graph mismatch stops the attempt without rewriting it or resolving packages. Shut down only the selected device if this invocation booted it, and release every fixture gate/whole worker before cleanup. Preserve all logs and result bundles.

Extract the workflow's exact inline result validator for local evidence; this keeps the expected method set and refusal checks identical:

```sh
python3 - "$A2_RESULTS/validate.py" <<'PY'
from pathlib import Path
import sys
lines = Path('.github/workflows/ci.yml').read_text().splitlines()
start = next(i for i, line in enumerate(lines) if '# A2_VALIDATOR_BEGIN' in line)
end = next(i for i, line in enumerate(lines) if '# A2_VALIDATOR_END' in line)
Path(sys.argv[1]).write_text('\n'.join(line[10:] for line in lines[start + 1:end]) + '\n')
PY
python3 "$A2_RESULTS/validate.py" "$A2_RESULTS/summary.json" "$A2_RESULTS/tests.json"
```

The validator rejects zero, missing, duplicate, unknown or skipped methods and mismatched summary totals, and proves refusal of malformed/empty/omitted-method evidence before trusting a result. A successful build with zero tests is not acceptance. For the first smoke, filter only `.../testActualCompositionSmoke` and set validator `A2_EXPECTED_METHODS=testActualCompositionSmoke`. A separately scoped sensitivity run removes only the actual App `FirstLaunch.requireWipe(defaults: defaults)` call: filter `.../testCurrentLateFailedWipeRearmsNextLaunch` and validate with that method plus `A2_EXPECT_FAILURE=1`. Require its named marker failure after the genuine failed wipe; compiler/discovery/timeouts are not sensitivity. Restore exact source bytes before the full class green. Attempts and time/disk limits must be allocated in advance; a setup or behavior surprise stops without an automatic extra run.

Cancelled old member/workspace cases prove actual URLProtocol stop and whole-worker cleanup with independent G2 success. They do not prove late decoded old data. The old sign-out case uses a test-only public bounded revocation wait of zero and a held synthetic revoke to deliver its captured failed-wipe completion after G2 loads; production defaults stay unchanged. The current-owner failed-wipe case uses a NEW service/coordinator on simulated next launch over the same retained store/defaults. These source checks do not qualify real Keychain/reinstall interruption, provider revocation safety, browser/device UX, signing, distribution or the later accepted-owner bridge. The identity reader remains unwired.

Source checks, host tests, unsigned builds, simulators and physical-device tests are separate evidence classes.

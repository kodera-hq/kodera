#!/usr/bin/env bash
# Proves the app resource check can fail, and that each guard fails for its own
# reason.
#
# Every case asserts the MESSAGE, the number of findings and the exit status.
# One bit cannot tell the guards apart: a run where every guard but one works
# would otherwise look the same as a run where all of them do. The finding
# count keeps each mutation surgical, so a case cannot pass on a message some
# other guard happened to print.
#
# Each case mutates a COPY of app/src and the build files in a scratch
# directory, never the tree. Tracked files only: a developer's untracked
# local.properties is not under test.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
check="$here/check-app-resources.py"
[ -f "$check" ] || { echo "self-test FAILED: $check is missing" >&2; exit 1; }
[ -d "$root/app/src" ] || { echo "self-test FAILED: $root/app/src is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/app-resources-selftest.XXXXXX")"
trap 'rm -r -- "$work"' EXIT

fail() { echo "self-test FAILED: $1" >&2; exit 1; }

cases=0
_out=""
_status=0
run() {
  if _out="$(python3 "$check" "$work" 2>&1)"; then _status=0; else _status=$?; fi
}

fresh() {
  if [ -d "$work/app" ]; then rm -r -- "$work/app"; fi
  if [ -d "$work/config" ]; then rm -r -- "$work/config"; fi
  mkdir -p "$work/app" "$work/config"
  cp -R "$root/app/src" "$work/app/src"
  cp "$root/app/build.gradle.kts" "$work/app/"
  cp "$root/build.gradle.kts" "$root/settings.gradle.kts" "$root/gradle.properties" "$work/"
  cp "$root/config/local.properties.example" "$work/config/"
}

M=app/src/main

# replace FILE OLD NEW — exactly once. A helper that silently matched nothing
# would leave the copy clean; it fails instead.
replace() {
  python3 - "$work/$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if text.count(old) != 1:
    sys.exit(f"self-test helper: {old!r} occurs {text.count(old)} times in {path}")
open(path, "w", encoding="utf-8").write(text.replace(old, new))
PY
}
# edit_json FILE EXPR — a Python expression on `d`.
edit_json() {
  python3 - "$work/$1" "$2" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding="utf-8"))
exec(expr)
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

# repin_token_manifest EXPR [SOURCE] — edits native-token-manifest.json with a
# Python expression on `d`, re-pins its hash in tokens.json and, when SOURCE is
# given, sets tokens.json sourceSha256 to it. One guard then speaks alone.
repin_token_manifest() {
  python3 - "$work/$M/assets/provenance" "$1" "${2-}" "${2+set}" <<'PY'
import hashlib, json, os, sys
folder, expr, source, has_source = sys.argv[1:5]
manifest, pin = os.path.join(folder, "native-token-manifest.json"), os.path.join(folder, "tokens.json")
d = json.load(open(manifest, encoding="utf-8"))
exec(expr)
json.dump(d, open(manifest, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
p = json.load(open(pin, encoding="utf-8"))
p["manifestSha256"] = hashlib.sha256(open(manifest, "rb").read()).hexdigest()
if has_source:
    p["sourceSha256"] = source
json.dump(p, open(pin, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

# expect_refusal LABEL COUNT MESSAGE — after the mutation was applied.
expect_refusal() {
  local label="$1" count="$2" want="$3"
  run
  printf '%s\n' "$_out" | grep -qF -- "::error::$want" || fail "$label
  expected text: ::error::$want
  actual output: $_out"
  printf '%s\n' "$_out" | grep -qxF -- "$count app resource finding(s)" || fail "$label
  expected exactly $count finding(s)
  actual output: $_out"
  [ "$_status" -eq 1 ] || fail "$label: refused but exited $_status, not 1
  actual output: $_out"
  cases=$((cases + 1))
  printf '  ok  %s\n' "$label"
}

expect_clean() {
  run
  printf '%s\n' "$_out" | grep -qxF "app resources are complete and match their pins" || fail "the real app/src was refused
  actual output: $_out"
  if printf '%s\n' "$_out" | grep -q '::error'; then fail "a finding on the real app/src: $_out"; fi
  [ "$_status" -eq 0 ] || fail "the real app/src passed but exited $_status"
  cases=$((cases + 1))
  printf '  ok  %s\n' "$1"
}

expect_unreadable() {
  run
  printf '%s\n' "$_out" | grep -qF "Nothing was checked." || fail "$1 was not reported as unreadable
  actual output: $_out"
  [ "$_status" -eq 2 ] || fail "$1 exited $_status, not 2
  actual output: $_out"
  cases=$((cases + 1))
  printf '  ok  %s\n' "$1 is 'could not look' (exit 2), not clean"
}

fresh
expect_clean "the real app/src passes"

# ── tokens ─────────────────────────────────────────────────────────────────
fresh; printf '\n// hand edit\n' >> "$work/$M/kotlin/io/kodera/tokens/KoderaTokens.kt"
expect_refusal "a hand-edited token file" 1 \
  "KoderaTokens.kt differs from tokens.json generatedSha256"

fresh; printf '\n' >> "$work/$M/assets/provenance/native-token-manifest.json"
expect_refusal "a token manifest that drifted" 1 \
  "native-token-manifest.json differs from tokens.json manifestSha256"

fresh; edit_json $M/assets/provenance/tokens.json 'd["format"] = "kodera-native-tokens/2"'
expect_refusal "an unsupported token format" 1 "tokens.json format is not kodera-native-tokens/1"

fresh; edit_json $M/assets/provenance/tokens.json 'd["producerCommit"] = "0" * 40'
expect_refusal "an unqualified token producer" 1 \
  "tokens.json producerCommit is not the qualified token producer"

fresh; edit_json $M/assets/provenance/tokens.json 'd["sourceSha256"] = "f" * 64'
expect_refusal "a token source identity that differs" 1 \
  "the token source checksum differs between tokens.json, its manifest and KoderaTokens.kt"

# Each clause of the three-way source checksum, alone.
fresh; repin_token_manifest 'd["source"]["sha256"] = "f" * 64' ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
expect_refusal "a token source re-pinned in both files but absent from KoderaTokens.kt" 1 \
  "the token source checksum differs between tokens.json, its manifest and KoderaTokens.kt"

fresh; repin_token_manifest 'd["source"]["sha256"] = "e" * 64'
expect_refusal "a token manifest whose source differs from tokens.json" 1 \
  "the token source checksum differs between tokens.json, its manifest and KoderaTokens.kt"

fresh; repin_token_manifest 'd["source"]["sha256"] = ""' ""
expect_refusal "an empty token source identity" 1 \
  "the token source checksum differs between tokens.json, its manifest and KoderaTokens.kt"

# ── catalogues ─────────────────────────────────────────────────────────────
fresh; replace $M/res/values-en/strings.xml '<string name="discovery_action">' '<!-- dropped --><string name="discovery_action_gone">'
expect_refusal "an English catalogue missing a French key" 2 "res/values-en/strings.xml lacks discovery_action"

fresh; replace $M/res/values-en/strings.xml '</resources>' '<string name="english_only">Only here</string></resources>'
expect_refusal "an English key with no French default" 1 \
  "res/values/strings.xml (French, the default) lacks english_only"

fresh; replace $M/res/values/strings.xml '<string name="discovery_action">Rechercher</string>' '<string name="discovery_action"></string>'
expect_refusal "an empty string" 1 "res/values/strings.xml: discovery_action is empty"

# input_clear is required copy AND present in English, so both guards speak.
fresh; replace $M/res/values/strings.xml '<string name="input_clear">Effacer</string>' ''
expect_refusal "missing required accessible copy" 2 \
  "res/values/strings.xml lacks required accessible copy input_clear"

fresh; python3 - "$work/$M/res/values/strings.xml" <<'PY'
import re, sys
p = sys.argv[1]; t = open(p).read()
t, n = re.subn(r'\s*<string name="session_sign_out_hint">[^<]*</string>', "", t)
assert n == 1; open(p, "w").write(t)
PY
expect_refusal "missing sign-out hint" 2 \
  "res/values/strings.xml lacks required accessible copy session_sign_out_hint"

# The sign-out hint states the per-client sign-out rule: a hint that says "this device" again is refused, in each language.
fresh; replace $M/res/values/strings.xml 'Vous déconnecte de l’application Kodera sur tous vos appareils Android.' 'Ferme la session sur cet appareil.'
expect_refusal "a French sign-out hint that no longer says every device" 1 \
  "res/values/strings.xml: session_sign_out_hint must read \"Vous déconnecte de l’application Kodera sur tous vos appareils Android.\""

fresh; replace $M/res/values-en/strings.xml 'Signs you out of the Kodera app on all your Android devices.' 'Ends the session on this device.'
expect_refusal "an English sign-out hint that no longer says every device" 1 \
  "res/values-en/strings.xml: session_sign_out_hint must read \"Signs you out of the Kodera app on all your Android devices.\""

fresh; replace $M/res/values/strings.xml '<string name="session_restoring">Ouverture de votre session…</string>' ''
expect_refusal "missing restoring label" 2 \
  "res/values/strings.xml lacks required accessible copy session_restoring"

# ── fonts and licences ─────────────────────────────────────────────────────
fresh; printf 'x' >> "$work/$M/res/font/ibm_plex_mono_regular.ttf"
expect_refusal "a font that drifted from its source" 1 \
  "font ibm_plex_mono_regular.ttf differs from its source hash"

fresh; printf 'x' > "$work/$M/res/font/unbound_font.ttf"
expect_refusal "a font file that is not bound" 1 "res/font differs from android-font-bindings.json"

fresh; edit_json $M/assets/provenance/android-font-bindings.json 'd["fonts"][1]["weight"] = 501'
expect_refusal "a binding to another face" 1 \
  "font plus_jakarta_sans_medium.ttf is bound to a different face than its source"

fresh; edit_json $M/assets/provenance/android-font-bindings.json \
  'import os; b = d["fonts"].pop(); os.remove(os.path.join(os.path.dirname(path), "../../res/font", b["resourceFile"]))'
expect_refusal "a binding removed together with its font file" 1 \
  "android-font-bindings.json does not bind each font of font-assets-source.json once"

# The directory no longer matches the bindings either, so both guards speak.
fresh; rm -- "$work/$M/res/font/ibm_plex_mono_regular.ttf"
expect_refusal "a bound font file that is missing" 2 "font ibm_plex_mono_regular.ttf differs from its source hash"

fresh; printf 'x' >> "$work/$M/assets/licenses/OFL-ibm-plex-mono.txt"
expect_refusal "a licence notice that drifted" 1 \
  "font licence OFL-ibm-plex-mono.txt differs from its source hash"

# Both guards speak: one notice short, and the listed one is gone.
fresh; rm -- "$work/$M/assets/licenses/OFL-plus-jakarta-sans.txt"
expect_refusal "a missing licence notice" 2 \
  "expected 2 OFL font licence notices in assets/licenses, found 1"

# Two notices are still present, so only the listed-notice guard can see it.
fresh; mv -- "$work/$M/assets/licenses/OFL-plus-jakarta-sans.txt" "$work/$M/assets/licenses/OFL-renamed.txt"
expect_refusal "a listed licence notice replaced by another file" 1 \
  "font licence OFL-plus-jakarta-sans.txt listed in font-assets-source.json is missing"

# ── AndroidManifest.xml ────────────────────────────────────────────────────
fresh; replace $M/AndroidManifest.xml 'android:allowBackup="false"' 'android:allowBackup="true"'
expect_refusal "backup allowed" 1 'AndroidManifest.xml does not set android:allowBackup="false"'

fresh; replace $M/AndroidManifest.xml 'android:usesCleartextTraffic="false"' 'android:usesCleartextTraffic="true"'
expect_refusal "cleartext traffic allowed" 1 'AndroidManifest.xml does not set android:usesCleartextTraffic="false"'

fresh; replace $M/AndroidManifest.xml 'android:usesCleartextTraffic="false">' 'android:usesCleartextTraffic="false" android:networkSecurityConfig="@xml/network_security_config">'
expect_refusal "a network security configuration" 1 \
  "AndroidManifest.xml sets android:networkSecurityConfig; only the debug source set may"

fresh; printf '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/></manifest>\n' > "$work/$M/AndroidManifest.xml"
expect_refusal "a manifest with no application element" 4 'AndroidManifest.xml does not set android:allowBackup="false"'

fresh; replace $M/AndroidManifest.xml '<application' '<uses-permission android:name="android.permission.CAMERA"/><application'
expect_refusal "an extra permission" 1 "AndroidManifest.xml asks for permissions other than exactly INTERNET"

fresh; replace $M/AndroidManifest.xml '<application' '<uses-permission-sdk-23 android:name="android.permission.CAMERA"/><application'
expect_refusal "an extra API 23+ permission" 1 "AndroidManifest.xml asks for permissions other than exactly INTERNET"

# Each clause of the launcher filter guard, alone.
fresh; replace $M/AndroidManifest.xml '<action android:name="android.intent.action.MAIN" />' '<action android:name="android.intent.action.MAIN" /><action android:name="android.intent.action.VIEW" />'
expect_refusal "a launcher filter with another action" 1 "AndroidManifest.xml declares an intent filter other than MAIN/LAUNCHER"

fresh; replace $M/AndroidManifest.xml 'android.intent.category.LAUNCHER' 'android.intent.category.DEFAULT'
expect_refusal "a MAIN filter with the DEFAULT category" 1 "AndroidManifest.xml declares an intent filter other than MAIN/LAUNCHER"

fresh; replace $M/AndroidManifest.xml '<category android:name="android.intent.category.LAUNCHER" />' '<category android:name="android.intent.category.LAUNCHER" /><data android:scheme="io.kodera.app" />'
expect_refusal "a MAIN/LAUNCHER filter with a data element" 1 "AndroidManifest.xml declares an intent filter other than MAIN/LAUNCHER"

# Exported components other than the launcher activity.
fresh; replace $M/AndroidManifest.xml '    </application>' '        <provider android:name=".Shared" android:authorities="io.kodera.app.shared" android:exported="true" />
    </application>'
expect_refusal "an exported provider" 1 "AndroidManifest.xml exports a provider (.Shared)"

fresh; replace $M/AndroidManifest.xml '    </application>' '        <receiver android:name=".Wake" android:exported="true" />
    </application>'
expect_refusal "an exported receiver" 1 "AndroidManifest.xml exports a receiver (.Wake)"

fresh; replace $M/AndroidManifest.xml '    </application>' '        <service android:name=".Sync" android:exported="true" />
    </application>'
expect_refusal "an exported service" 1 "AndroidManifest.xml exports a service (.Sync)"

fresh; replace $M/AndroidManifest.xml '    </application>' '        <service android:name=".Loud" android:exported="TRUE" />
    </application>'
expect_refusal "a service exported by TRUE" 1 "AndroidManifest.xml exports a service (.Loud)"

# No android:exported, but an intent filter: exposed all the same. The filter
# is not MAIN/LAUNCHER either, so that guard speaks too.
fresh; replace $M/AndroidManifest.xml '    </application>' '        <receiver android:name=".Boot"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter></receiver>
    </application>'
expect_refusal "a receiver exposed by an intent filter alone" 2 "AndroidManifest.xml exports a receiver (.Boot)"

fresh; replace $M/AndroidManifest.xml '        </activity>' '            <intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="io.kodera.app"/></intent-filter>
        </activity>'
expect_refusal "a callback intent filter" 1 "AndroidManifest.xml declares an intent filter other than MAIN/LAUNCHER"

fresh; replace $M/AndroidManifest.xml '        <activity' '        <meta-data android:name="io.kodera.android.CORE_ORIGIN" android:resource="@string/brand_name"/>
        <activity'
expect_refusal "a default Core origin in the manifest" 1 \
  "main/AndroidManifest.xml carries default deployment key io.kodera.android.CORE_ORIGIN"

fresh; mkdir -p "$work/app/src/debug/res/values"
printf '<resources><string name="x">io.kodera.android.ISSUER_ORIGINS</string></resources>\n' > "$work/app/src/debug/res/values/deployment.xml"
expect_refusal "default issuer origins in another source set" 1 \
  "debug/res/values/deployment.xml carries default deployment key io.kodera.android.ISSUER_ORIGINS"

# ── backup and device transfer ─────────────────────────────────────────────
X=$M/res/xml
fresh; replace $M/AndroidManifest.xml '        android:dataExtractionRules="@xml/data_extraction_rules"
' ''
expect_refusal "a manifest without data extraction rules" 1 \
  'AndroidManifest.xml does not set android:dataExtractionRules="@xml/data_extraction_rules"'

fresh; replace $M/AndroidManifest.xml 'android:fullBackupContent="@xml/backup_rules"' 'android:fullBackupContent="@xml/other_rules"'
expect_refusal "a manifest naming other backup rules" 1 \
  'AndroidManifest.xml does not set android:fullBackupContent="@xml/backup_rules"'

fresh; python3 - "$work/$X/data_extraction_rules.xml" <<'PY'
import re, sys
p = sys.argv[1]; t = open(p).read()
t, n = re.subn(r"(<device-transfer>)\s*<exclude[^>]*/>", r"\1", t)
assert n == 1; open(p, "w").write(t)
PY
expect_refusal "device transfer that carries the session" 1 \
  "data_extraction_rules.xml does not exclude the session directory from device-transfer"

fresh; python3 - "$work/$X/data_extraction_rules.xml" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
i = t.index("<cloud-backup>"); j = t.index('path="session"', i)
open(p, "w").write(t[:j] + 'path="sessions"' + t[j + len('path="session"'):])
PY
expect_refusal "a cloud-backup exclude for another path" 1 \
  "data_extraction_rules.xml does not exclude the session directory from cloud-backup"

fresh; replace $X/backup_rules.xml 'domain="file"' 'domain="database"'
expect_refusal "full backup that carries the session" 1 \
  "backup_rules.xml does not exclude the session directory from full backup"

# ── network security configuration ─────────────────────────────────────────
N=app/src/debug/res/xml/debug_loopback_cleartext.xml
fresh; mkdir -p "$work/app/src/release"
printf '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/debug_loopback_cleartext"/></manifest>\n' > "$work/app/src/release/AndroidManifest.xml"
expect_refusal "a release manifest naming the loopback configuration" 1 \
  "release/AndroidManifest.xml names network security configuration @xml/debug_loopback_cleartext"

fresh; replace app/src/debug/AndroidManifest.xml '@xml/debug_loopback_cleartext' '@xml/permissive'
expect_refusal "a debug manifest naming another configuration" 1 \
  "debug/AndroidManifest.xml names network security configuration @xml/permissive"

fresh; cp -- "$work/$N" "$work/$X/network_security_config.xml"
expect_refusal "a network security configuration in main" 1 \
  "main/res/xml/network_security_config.xml is a network security configuration outside"

fresh; replace $N '<domain includeSubdomains="false">127.0.0.1</domain>' '<domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">10.0.2.2</domain>'
expect_refusal "cleartext to another host" 1 "debug/res/xml/debug_loopback_cleartext.xml: cleartext must reach exactly"

fresh; replace $N '<domain includeSubdomains="false">localhost</domain>' '<domain includeSubdomains="true">localhost</domain>'
expect_refusal "cleartext to loopback subdomains" 1 "debug/res/xml/debug_loopback_cleartext.xml: cleartext must reach exactly"

# Only the element name changes: hosts and subdomain flags still match.
fresh; replace $N '<domain includeSubdomains="false">localhost</domain>' '<pin-set includeSubdomains="false">localhost</pin-set>'
expect_refusal "a domain-config child that is not a domain" 1 "debug/res/xml/debug_loopback_cleartext.xml: cleartext must reach exactly"

fresh; replace $N '<domain-config cleartextTrafficPermitted="true">' '<domain-config cleartextTrafficPermitted="true"><trust-anchors><certificates src="user" /></trust-anchors>'
expect_refusal "user trust anchors for loopback" 1 "debug/res/xml/debug_loopback_cleartext.xml: cleartext must reach exactly"

fresh; replace $N '<base-config cleartextTrafficPermitted="false" />' '<base-config cleartextTrafficPermitted="true" />'
expect_refusal "cleartext everywhere" 1 "debug/res/xml/debug_loopback_cleartext.xml: base-config must refuse cleartext"

fresh; replace $N '<base-config cleartextTrafficPermitted="false" />' '<base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="user" /></trust-anchors></base-config>'
expect_refusal "user trust anchors everywhere" 1 "debug/res/xml/debug_loopback_cleartext.xml: base-config must refuse cleartext"

fresh; replace $N '</network-security-config>' '<debug-overrides><trust-anchors><certificates src="user" /></trust-anchors></debug-overrides></network-security-config>'
expect_refusal "debug overrides" 1 "debug/res/xml/debug_loopback_cleartext.xml must hold exactly one base-config and one domain-config"

# ── literals in app sources ────────────────────────────────────────────────
K=$M/kotlin/io/kodera/android
fresh; replace $M/res/values/strings.xml '<string name="discovery_action">Rechercher</string>' '<string name="discovery_action">Rechercher sur https://id.example</string>'
expect_refusal "a URL in a catalogue" 1 "main/res/values/strings.xml carries an http(s):// literal"

fresh; printf '\nprivate const val FALLBACK = "HTTPS://core.example"\n' >> "$work/$K/MainActivity.kt"
expect_refusal "an upper-case URL in app Kotlin" 1 "main/kotlin/io/kodera/android/MainActivity.kt carries an http(s):// literal"

fresh; printf '\nprivate val clientID = "someone-else"\n' >> "$work/$K/session/SessionController.kt"
expect_refusal "a client ID in any case" 1 "main/kotlin/io/kodera/android/session/SessionController.kt hard-codes a client ID"

fresh; printf '\nprivate val fallback = "Kodera-Android"\n' >> "$work/$K/session/SessionController.kt"
expect_refusal "the client name as a literal" 1 "main/kotlin/io/kodera/android/session/SessionController.kt hard-codes a client ID"

fresh; printf '\nprivate fun pinned(t: io.kodera.android.client.AccessTokenProvider) = CoreRequester( "core", DevelopmentBuild.loopback, t)\n' >> "$work/$K/session/SessionController.kt"
expect_refusal "a literal passed to a deployment constructor" 1 \
  "main/kotlin/io/kodera/android/session/SessionController.kt passes a string literal to a deployment constructor"

# A release build admitting loopback or reading the development issuer is
# refused by app/src/testRelease (DevelopmentBuildReleaseTests). The text rule
# only keeps the admitting value's name in src/debug (and the test sets).
fresh; printf '\nprivate val widened = io.kodera.android.domain.LoopbackPolicy.ADMIT_FOR_DEVELOPMENT\n' >> "$work/$K/session/SessionController.kt"
expect_refusal "the loopback-admitting value in main" 1 \
  "main/kotlin/io/kodera/android/session/SessionController.kt names ADMIT_FOR_DEVELOPMENT; only app/src/debug may admit plain-HTTP loopback"

fresh; replace app/src/release/kotlin/io/kodera/android/DevelopmentBuild.kt 'LoopbackPolicy = LoopbackPolicy.REFUSE' 'LoopbackPolicy = LoopbackPolicy.ADMIT_FOR_DEVELOPMENT'
expect_refusal "the loopback-admitting value in release" 1 \
  "release/kotlin/io/kodera/android/DevelopmentBuild.kt names ADMIT_FOR_DEVELOPMENT; only app/src/debug may admit plain-HTTP loopback"

fresh; mkdir -p "$work/app/src/staging/kotlin/io/kodera/android"
printf 'package io.kodera.android\n\nprivate val widened = io.kodera.android.domain.LoopbackPolicy.ADMIT_FOR_DEVELOPMENT\n' > "$work/app/src/staging/kotlin/io/kodera/android/Widened.kt"
expect_refusal "the loopback-admitting value in a new source set" 1 \
  "staging/kotlin/io/kodera/android/Widened.kt names ADMIT_FOR_DEVELOPMENT; only app/src/debug may admit plain-HTTP loopback"

# ── DeploymentConfiguration.kt ─────────────────────────────────────────────
D=$K/entry/DeploymentConfiguration.kt
# A URL literal: the app-wide guard, the file's own endpoint guard and its no-literal guard all speak.
fresh; printf '\nprivate const val FALLBACK_CORE = "https://core.example"\n' >> "$work/$D"
expect_refusal "a hard-coded endpoint" 3 "DeploymentConfiguration.kt hard-codes an https:// endpoint"

fresh; printf '\nprivate const val FALLBACK_CORE = "http://core.example"\n' >> "$work/$D"
expect_refusal "a hard-coded cleartext endpoint" 3 "DeploymentConfiguration.kt hard-codes an http:// endpoint"

fresh; printf '\nprivate const val CLIENT_ID = "someone-else"\n' >> "$work/$D"
expect_refusal "a hard-coded client ID" 2 "main/kotlin/io/kodera/android/entry/DeploymentConfiguration.kt hard-codes a client ID"

fresh; printf '\nprivate const val SEPARATOR = " "\n' >> "$work/$D"
expect_refusal "any string literal in the configuration" 1 \
  "DeploymentConfiguration.kt holds a string literal; deployment values come only from BuildConfig"

fresh; replace $D 'BuildConfig.KODERA_CLIENT_ID,' 'BuildConfig.KODERA_CORE_ORIGIN,'
expect_refusal "a configuration that stops reading the client ID setting" 1 \
  "DeploymentConfiguration.kt does not read BuildConfig.KODERA_CLIENT_ID"

fresh; replace $D 'BuildConfig.KODERA_CONSOLE_ORIGIN))' 'BuildConfig.KODERA_CORE_ORIGIN))'
expect_refusal "a configuration that stops reading the Console origin setting" 1 \
  "DeploymentConfiguration.kt does not read BuildConfig.KODERA_CONSOLE_ORIGIN"

# ── Gradle and config/ ─────────────────────────────────────────────────────
G=app/build.gradle.kts
fresh; replace $G 'buildConfigField("String", "KODERA_CLIENT_ID", buildConfigString("kodera.clientId"))' 'buildConfigField("String", "KODERA_CLIENT_ID", "\"someone-else\"")'
expect_refusal "a literal build field" 1 "app/build.gradle.kts gives KODERA_CLIENT_ID a value other than"

fresh; replace $G 'buildConfigField("String", "KODERA_CLIENT_ID", buildConfigString("kodera.clientId"))' 'buildConfigField("String", "KODERA_CLIENT_ID", buildConfigString("kodera.coreOrigin"))'
expect_refusal "a build field fed by another property" 1 "app/build.gradle.kts gives KODERA_CLIENT_ID a value other than"

fresh; replace $G 'buildConfigField("String", "KODERA_CONSOLE_ORIGIN", buildConfigString("kodera.consoleOrigin"))' 'buildConfigField("String", "KODERA_CONSOLE_ORIGIN", buildConfigString("kodera.coreOrigin"))'
expect_refusal "a Console origin fed by another property" 1 "app/build.gradle.kts gives KODERA_CONSOLE_ORIGIN a value other than"

fresh; replace $G '            isMinifyEnabled = false' '            isMinifyEnabled = false
            buildConfigField("String", "KODERA_CORE_ORIGIN", buildConfigString("kodera.coreOrigin"))'
expect_refusal "a build-type override of a deployment field" 1 "app/build.gradle.kts declares KODERA_CORE_ORIGIN 2 times, not once"

fresh; replace $G '            isMinifyEnabled = false' '            isMinifyEnabled = false
            manifestPlaceholders["KODERA_ORIGIN"] = "core"'
expect_refusal "a deployment value outside a build field" 1 "app/build.gradle.kts sets a KODERA_ value outside a buildConfigField"

fresh; replace $G '            isMinifyEnabled = false' '            isMinifyEnabled = false
            resValue("string", "core", "core")'
expect_refusal "a resource value" 1 "app/build.gradle.kts uses resValue"

fresh; printf '\n// mirror: https://example.test\n' >> "$work/$G"
expect_refusal "a URL in the app build file" 1 "app/build.gradle.kts carries an http(s):// literal"

fresh; replace $G 'manifestPlaceholders["appAuthRedirectScheme"] = "io.kodera.app"' 'manifestPlaceholders["appAuthRedirectScheme"] = applicationId!!'
expect_refusal "a redirect scheme derived from the application ID" 1 \
  "app/build.gradle.kts must set appAuthRedirectScheme exactly once, to the literal io.kodera.app"

fresh; printf 'kodera.clientId=someone-else\n' >> "$work/gradle.properties"
expect_refusal "a committed deployment property" 1 "gradle.properties sets a deployment value"

E=config/local.properties.example
fresh; replace $E 'kodera.issuerOrigins=http://localhost:8080' 'kodera.issuerOrigins=http://localhost:8080 https://auth.kodera.io'
expect_refusal "a real issuer origin in the example" 1 \
  "config/local.properties.example sets kodera.issuerOrigins to a value that is not loopback-only"

fresh; replace $E 'kodera.coreOrigin=http://localhost:8000' 'kodera.coreOrigin=http://localhost.evil.test:8000'
expect_refusal "a lookalike loopback Core origin in the example" 1 \
  "config/local.properties.example sets kodera.coreOrigin to a value that is not loopback-only"

fresh; replace $E 'kodera.devIssuer=http://localhost:8080/realms/kodera-dev' 'kodera.devIssuer=https://auth.kodera.io/realms/kodera-dev'
expect_refusal "a real development issuer in the example" 1 \
  "config/local.properties.example sets kodera.devIssuer to a value that is not loopback-only"

fresh; replace $E 'kodera.consoleOrigin=http://localhost:5173' 'kodera.consoleOrigin=https://console.kodera.io'
expect_refusal "a real Console origin in the example" 1 \
  "config/local.properties.example sets kodera.consoleOrigin to a value that is not loopback-only"

fresh; replace $E 'kodera.clientId=kodera-android' 'kodera.clientId=http://x'
expect_refusal "a client ID that is not an identifier in the example" 1 \
  "config/local.properties.example sets kodera.clientId to a value that is not loopback-only"

fresh; replace $E 'kodera.offlineAccess=true' 'kodera.offlineAccess=yes'
expect_refusal "an offline-access switch that is not true or false in the example" 1 \
  "config/local.properties.example sets kodera.offlineAccess to a value that is not loopback-only"

fresh; replace $E 'kodera.clientId=kodera-android' '# kodera.clientId removed'
expect_refusal "an example that drops a setting" 1 "config/local.properties.example must set exactly"

# ── could not look ─────────────────────────────────────────────────────────
fresh; rm -- "$work/$M/assets/provenance/tokens.json"
expect_unreadable "a missing input"

fresh; printf '<manifest' > "$work/$M/AndroidManifest.xml"
expect_unreadable "a malformed manifest"

fresh; printf '{"fonts": ' > "$work/$M/assets/provenance/font-assets-source.json"
expect_unreadable "a malformed JSON input"

fresh; rm -r -- "$work/$M/res/font"
expect_unreadable "a missing res/font directory"

fresh; rm -- "$work/config/local.properties.example"
expect_unreadable "a missing config/local.properties.example"

# Inputs of the wrong shape: each exception the checker turns into exit 2.
fresh; edit_json $M/assets/provenance/android-font-bindings.json 'del d["fonts"][0]["resourceFile"]'
expect_unreadable "a binding without resourceFile (KeyError)"

fresh; edit_json $M/assets/provenance/font-assets-source.json 'd["fonts"] = 5'
expect_unreadable "a font list that is a number (TypeError)"

fresh; edit_json $M/assets/provenance/tokens.json 'd = []'
expect_unreadable "a token pin that is a list (AttributeError)"

fresh
expect_clean "the copy passes again once restored"

# ── --merged: the manifest AGP merged from every dependency ────────────────
# Fed by a fixture shaped like today's merged debug manifest; CI runs the same
# mode on the real one after assembleDebug.
mode=--merged
run_merged() {
  if _out="$(python3 "$check" "$mode" "$work/merged.xml" 2>&1)"; then _status=0; else _status=$?; fi
}
merged_fresh() { mode=--merged; cp -- "$here/check-app-resources.merged-fixture.xml" "$work/merged.xml"; }
F=merged.xml

expect_merged_refusal() {
  local label="$1" count="$2" want="$3"
  run_merged
  printf '%s\n' "$_out" | grep -qF -- "::error::$want" || fail "--merged: $label
  expected text: ::error::$want
  actual output: $_out"
  printf '%s\n' "$_out" | grep -qxF -- "$count app resource finding(s)" || fail "--merged: $label
  expected exactly $count finding(s)
  actual output: $_out"
  [ "$_status" -eq 1 ] || fail "--merged: $label: refused but exited $_status, not 1
  actual output: $_out"
  cases=$((cases + 1))
  printf '  ok  --merged: %s\n' "$label"
}

merged_fresh; run_merged
printf '%s\n' "$_out" | grep -qxF "the merged manifest stays inside its allowlist" || fail "--merged: the fixture was refused
  actual output: $_out"
if printf '%s\n' "$_out" | grep -q '::error'; then fail "--merged: a finding on the fixture: $_out"; fi
[ "$_status" -eq 0 ] || fail "--merged: the fixture passed but exited $_status"
cases=$((cases + 1)); printf '  ok  --merged: the fixture passes\n'

merged_fresh; replace $F '<application' '<uses-permission android:name="android.permission.CAMERA" /><application'
expect_merged_refusal "a permission a dependency added" 1 \
  "merged manifest asks for android.permission.CAMERA, outside the allowlist"

merged_fresh; replace $F '<application' '<uses-permission-sdk-23 android:name="android.permission.READ_CONTACTS" /><application'
expect_merged_refusal "an API 23+ permission a dependency added" 1 \
  "merged manifest asks for android.permission.READ_CONTACTS, outside the allowlist"

merged_fresh; replace $F 'android:protectionLevel="signature"' 'android:protectionLevel="normal"'
expect_merged_refusal "a declared permission that is not signature-protected" 1 \
  "merged manifest declares permission io.kodera.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION, outside the allowlist"

# No protectionLevel: absent from the allowlist must not compare None to None.
merged_fresh; replace $F '<application' '<permission android:name="com.example.FOO" /><application'
expect_merged_refusal "an undeclared permission with no protection level" 1 \
  "merged manifest declares permission com.example.FOO, outside the allowlist"

# Application attributes a library can bring through the merger.
merged_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="true"'
expect_merged_refusal "backup allowed" 1 'merged manifest does not set android:allowBackup="false"'

merged_fresh; replace $F 'android:usesCleartextTraffic="false"' 'android:usesCleartextTraffic="true"'
expect_merged_refusal "cleartext traffic allowed" 1 'merged manifest does not set android:usesCleartextTraffic="false"'

merged_fresh; replace $F 'android:networkSecurityConfig="@xml/debug_loopback_cleartext"' 'android:networkSecurityConfig="@xml/network_security_config"'
expect_merged_refusal "another network security configuration" 1 \
  "merged manifest sets android:networkSecurityConfig to @xml/network_security_config; only @xml/debug_loopback_cleartext is allowed"

# The release manifest names none, the debug one included.
merged_fresh; mode=--merged-release
expect_merged_refusal "a release manifest with the debug configuration" 1 \
  "merged manifest sets android:networkSecurityConfig to @xml/debug_loopback_cleartext; a release build names none"

merged_fresh; replace $F '        android:networkSecurityConfig="@xml/debug_loopback_cleartext"
' ''; mode=--merged-release; run_merged
printf '%s\n' "$_out" | grep -qxF "the merged manifest stays inside its allowlist" || fail "--merged-release: a release-shaped fixture was refused
  actual output: $_out"
[ "$_status" -eq 0 ] || fail "--merged-release: the release-shaped fixture exited $_status"
cases=$((cases + 1)); printf '  ok  --merged-release: a manifest with no configuration passes\n'

# A release build is never debuggable or test-only. Each case starts from the
# release-shaped fixture (no network security configuration), so it speaks alone.
release_fresh() {
  merged_fresh; replace $F '        android:networkSecurityConfig="@xml/debug_loopback_cleartext"
' ''; mode=--merged-release
}
release_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="false" android:debuggable="true"'
expect_merged_refusal "a debuggable release" 1 'merged release manifest sets android:debuggable="true"'

release_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="false" android:testOnly="true"'
expect_merged_refusal "a test-only release" 1 'merged release manifest sets android:testOnly="true"'

release_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="false" android:debuggable="@bool/debuggable"'
expect_merged_refusal "a release debuggable through a resource" 1 'merged release manifest sets android:debuggable="@bool/debuggable"'

# --merged, the debug manifest, is debuggable by design: the clause is release-only.
merged_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="false" android:debuggable="true"'
run_merged
printf '%s\n' "$_out" | grep -qxF "the merged manifest stays inside its allowlist" || fail "--merged: a debuggable debug manifest was refused
  actual output: $_out"
[ "$_status" -eq 0 ] || fail "--merged: a debuggable debug manifest exited $_status"
cases=$((cases + 1)); printf '  ok  --merged: a debug manifest may be debuggable\n'

release_fresh; replace $F 'android:allowBackup="false"' 'android:allowBackup="false" android:debuggable="false" android:testOnly="false"'
run_merged
printf '%s\n' "$_out" | grep -qxF "the merged manifest stays inside its allowlist" || fail "--merged-release: an explicit debuggable=false was refused
  actual output: $_out"
[ "$_status" -eq 0 ] || fail "--merged-release: an explicit debuggable=false exited $_status"
cases=$((cases + 1)); printf '  ok  --merged-release: explicit debuggable and testOnly "false" pass\n'

merged_fresh; replace $F 'android:dataExtractionRules="@xml/data_extraction_rules"' 'android:dataExtractionRules="@xml/library_rules"'
expect_merged_refusal "data extraction rules a library replaced" 1 \
  'merged manifest does not set android:dataExtractionRules="@xml/data_extraction_rules"'

# Every application guard speaks; there are no components to read.
merged_fresh; printf '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET" /></manifest>\n' > "$work/merged.xml"
expect_merged_refusal "a manifest with no application element" 4 'merged manifest does not set android:allowBackup="false"'

# AppAuth's redirect receiver: exactly VIEW + DEFAULT + BROWSABLE and the one scheme.
RA="net.openid.appauth.RedirectUriReceiverActivity"
merged_fresh; replace $F '<data android:scheme="io.kodera.app" />' '<data android:scheme="io.kodera.evil" />'
expect_merged_refusal "the redirect receiver for another scheme" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '<data android:scheme="io.kodera.app" />' '<data android:scheme="io.kodera.app" android:host="evil" />'
expect_merged_refusal "the redirect receiver with a host" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '<data android:scheme="io.kodera.app" />' '<data android:scheme="io.kodera.app" /><data android:scheme="https" />'
expect_merged_refusal "the redirect receiver with a second scheme" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '<data android:scheme="io.kodera.app" />' '<data android:scheme="io.kodera.app" /><data android:scheme="io.kodera.app" />'
expect_merged_refusal "the redirect receiver with a duplicated data element" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '<data android:scheme="io.kodera.app" />' ''
expect_merged_refusal "the redirect receiver with no scheme at all" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data' '                <category android:name="android.intent.category.BROWSABLE" />
                <data'
expect_merged_refusal "the redirect receiver without DEFAULT" 1 "merged manifest gives $RA an intent filter outside the allowlist"

merged_fresh; replace $F '            </intent-filter>
        </activity>
        <provider' '            </intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="https" /></intent-filter>
        </activity>
        <provider'
expect_merged_refusal "the redirect receiver with a second, https filter" 1 "merged manifest gives $RA an intent filter outside the allowlist"

# The redirect receiver must be the <activity> itself: an <activity-alias> of
# its name, or a targetActivity, would hand the code to another activity.
merged_fresh; replace $F '        <activity
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:exported="true">' '        <activity-alias
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:targetActivity="io.kodera.android.MainActivity"
            android:exported="true">'
replace $F '            </intent-filter>
        </activity>
        <provider' '            </intent-filter>
        </activity-alias>
        <provider'
expect_merged_refusal "the redirect receiver as an alias of the launcher" 2 \
  "merged manifest exports $RA as <activity-alias>, not <activity>"

merged_fresh; replace $F '        <activity
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:exported="true">' '        <activity
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:targetActivity="io.kodera.android.MainActivity"
            android:exported="true">'
expect_merged_refusal "the redirect receiver naming a targetActivity" 1 "merged manifest gives $RA a targetActivity"

merged_fresh; replace $F '        <activity
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:exported="true">' '        <activity-alias
            android:name="net.openid.appauth.RedirectUriReceiverActivity"
            android:exported="true">'
replace $F '            </intent-filter>
        </activity>
        <provider' '            </intent-filter>
        </activity-alias>
        <provider'
expect_merged_refusal "the redirect receiver as an alias, even without a target" 1 \
  "merged manifest exports $RA as <activity-alias>, not <activity>"

merged_fresh; replace $F 'android:name="net.openid.appauth.AuthorizationManagementActivity"
            android:exported="false"' 'android:name="net.openid.appauth.AuthorizationManagementActivity"
            android:exported="true"'
expect_merged_refusal "AppAuth's management activity exported" 1 \
  "merged manifest exports activity net.openid.appauth.AuthorizationManagementActivity, outside the allowlist"

merged_fresh; replace $F '    </application>' '        <activity-alias android:name="io.kodera.android.Alias" android:targetActivity="io.kodera.android.MainActivity" android:exported="true" />
    </application>'
expect_merged_refusal "an exported activity alias" 1 \
  "merged manifest exports activity-alias io.kodera.android.Alias, outside the allowlist"

merged_fresh; replace $F 'android:exported="false">
            <meta-data' 'android:exported="true">
            <meta-data'
expect_merged_refusal "an exported provider" 1 \
  "merged manifest exports provider androidx.startup.InitializationProvider, outside the allowlist"

merged_fresh; replace $F '    </application>' '        <receiver android:name="com.example.Wake" android:exported="true" />
    </application>'
expect_merged_refusal "an exported receiver" 1 "merged manifest exports receiver com.example.Wake, outside the allowlist"

# Anything but "false" may export: "TRUE", or a @bool/ resource.
merged_fresh; replace $F '    </application>' '        <receiver android:name="com.example.Loud" android:exported="TRUE" />
        <receiver android:name="com.example.Resolved" android:exported="@bool/exported" />
    </application>'
expect_merged_refusal "receivers exported by TRUE and by a resource" 2 \
  "merged manifest exports receiver com.example.Resolved, outside the allowlist"

merged_fresh; replace $F '    </application>' '        <service android:name="com.example.Sync"><intent-filter><action android:name="com.example.SYNC" /></intent-filter></service>
    </application>'
expect_merged_refusal "a service exposed by an intent filter alone" 1 \
  "merged manifest exports service com.example.Sync, outside the allowlist"

merged_fresh; replace $F '            android:permission="android.permission.DUMP">' '            >'
expect_merged_refusal "the profile receiver without its permission" 1 \
  "merged manifest exports androidx.profileinstaller.ProfileInstallReceiver without requiring android.permission.DUMP"

merged_fresh; replace $F '<action android:name="androidx.profileinstaller.action.SKIP_FILE" />' '<action android:name="androidx.profileinstaller.action.SKIP_FILE" /><category android:name="android.intent.category.BROWSABLE" />'
expect_merged_refusal "an allowlisted receiver with another category" 1 \
  "merged manifest gives androidx.profileinstaller.ProfileInstallReceiver an intent filter outside the allowlist"

merged_fresh; replace $F '<category android:name="android.intent.category.LAUNCHER" />' '<category android:name="android.intent.category.LAUNCHER" /><data android:scheme="io.kodera.app" />'
expect_merged_refusal "the launcher filter with a data element" 1 \
  "merged manifest gives io.kodera.android.MainActivity an intent filter outside the allowlist"

merged_fresh; replace $F '<category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>' '<category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.BROWSABLE" /></intent-filter>
        </activity>'
expect_merged_refusal "the launcher activity with a second filter" 1 \
  "merged manifest gives io.kodera.android.MainActivity an intent filter outside the allowlist"

# The shape of a browser callback filter, without its data: still not MAIN/LAUNCHER.
merged_fresh; replace $F '<category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>' '<category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.DEFAULT" /><category android:name="android.intent.category.BROWSABLE" /></intent-filter>
        </activity>'
expect_merged_refusal "the launcher activity with a browsable VIEW filter" 1 \
  "merged manifest gives io.kodera.android.MainActivity an intent filter outside the allowlist"

merged_fresh; printf '<manifest' > "$work/merged.xml"
run_merged
printf '%s\n' "$_out" | grep -qF "Nothing was checked." || fail "--merged: a malformed manifest was not reported as unreadable
  actual output: $_out"
[ "$_status" -eq 2 ] || fail "--merged: a malformed manifest exited $_status, not 2"
cases=$((cases + 1)); printf '  ok  --merged: a malformed manifest is could not look (exit 2)\n'

# A harness that aborted early, or a case list that shrank, must not pass.
expected_cases=135
[ "$cases" -eq "$expected_cases" ] || fail "ran $cases cases, expected $expected_cases"
echo "self-test passed: $cases cases, each proved by its own message, finding count AND exit status"

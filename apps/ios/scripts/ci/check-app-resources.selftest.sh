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
# Each case mutates a COPY of App/, Config/, project.yml and the Swift package
# manifests and sources in a scratch directory, never the tree.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
check="$here/check-app-resources.py"
[ -f "$check" ] || { echo "self-test FAILED: $check is missing" >&2; exit 1; }
[ -d "$root/App" ] || { echo "self-test FAILED: $root/App is missing" >&2; exit 1; }
[ -d "$root/Config" ] || { echo "self-test FAILED: $root/Config is missing" >&2; exit 1; }
[ -f "$root/project.yml" ] || { echo "self-test FAILED: $root/project.yml is missing" >&2; exit 1; }
[ -d "$root/packages" ] || { echo "self-test FAILED: $root/packages is missing" >&2; exit 1; }

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
  if [ -d "$work/App" ]; then rm -r -- "$work/App"; fi
  if [ -d "$work/Config" ]; then rm -r -- "$work/Config"; fi
  cp -R "$root/App" "$work/App"
  mkdir "$work/Config"
  # Tracked files only: a developer's untracked Local.xcconfig is not under test.
  cp "$root/Config/Kodera.xcconfig" "$root/Config/Local.xcconfig.example" "$work/Config/"
  cp "$root/project.yml" "$work/project.yml"
  # Manifests and sources only: build products and resolved dependencies are not under test.
  if [ -d "$work/packages" ]; then rm -r -- "$work/packages"; fi
  for package in "$root"/packages/*/; do
    name="$(basename "$package")"
    mkdir -p "$work/packages/$name"
    cp "$package/Package.swift" "$work/packages/$name/"
    cp -R "$package/Sources" "$work/packages/$name/Sources"
  done
}

# Replaces the whole line assigning SETTING in a copied Config file.
set_line() {
  python3 - "$work/Config/$1" "$2" "$3" <<'PY2'
import re, sys
path, setting, line = sys.argv[1:]
text = open(path, encoding="utf-8").read()
new, count = re.subn(r"(?m)^" + re.escape(setting) + r" =.*$", lambda _: line, text, count=1)
if count != 1:
    sys.exit(f"set_line: no unconditional {setting} line in {path}")
open(path, "w", encoding="utf-8").write(new)
PY2
}

# Edits a JSON or plist file of the copy in place with a Python expression on
# `d`. A helper that silently failed would leave the copy clean, which the
# finding-count assertion then reports as a missing refusal.
edit_json() {
  python3 - "$work/App/$1" "$2" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding="utf-8"))
exec(expr)
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}
edit_plist() {
  python3 - "$work/App/$1" "$2" <<'PY'
import plistlib, sys
path, expr = sys.argv[1], sys.argv[2]
d = plistlib.load(open(path, "rb"))
exec(expr)
plistlib.dump(d, open(path, "wb"))
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
  printf '%s\n' "$_out" | grep -qxF "app resources are complete and match their pins" || fail "the real App/ was refused
  actual output: $_out"
  if printf '%s\n' "$_out" | grep -q '::error'; then fail "a finding on the real App/: $_out"; fi
  [ "$_status" -eq 0 ] || fail "the real App/ passed but exited $_status"
  cases=$((cases + 1))
  printf '  ok  %s\n' "$1"
}

fresh
expect_clean "the real App/ passes"

# ── tokens ─────────────────────────────────────────────────────────────────
fresh; printf '\n// hand edit\n' >> "$work/App/Generated/KoderaTokens.swift"
expect_refusal "a hand-edited token file" 1 \
  "App/Generated/KoderaTokens.swift differs from TokenProvenance.json generatedSha256"

fresh; edit_json Generated/TokenProvenance.json 'd["format"] = "kodera-native-tokens/2"'
expect_refusal "an unsupported token format" 1 "TokenProvenance.json format is not kodera-native-tokens/1"

fresh; edit_json Generated/TokenProvenance.json 'd["producerCommit"] = "0" * 40'
expect_refusal "an unqualified token producer" 1 \
  "TokenProvenance.json producerCommit is not the qualified token producer"

fresh; edit_json Generated/TokenProvenance.json 'd["sourceSha256"] = "f" * 64'
expect_refusal "a token source identity that differs" 1 \
  "KoderaTokens.swift does not carry the sourceSha256 recorded in TokenProvenance.json"

fresh; edit_json Generated/TokenProvenance.json 'd["sourceSha256"] = ""'
expect_refusal "an empty token source identity" 1 \
  "KoderaTokens.swift does not carry the sourceSha256 recorded in TokenProvenance.json"

# ── catalogue ──────────────────────────────────────────────────────────────
fresh; edit_json Resources/Localizable.xcstrings 'd["sourceLanguage"] = "en"'
expect_refusal "a catalogue whose development language is not French" 1 \
  "Localizable.xcstrings sourceLanguage is not fr"

fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["brand.name"]["localizations"]["en"]["stringUnit"]["state"] = "new"'
expect_refusal "an untranslated string" 1 "Localizable.xcstrings: brand.name has no en translation"

fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["brand.name"]["localizations"]["en"]["stringUnit"]["value"] = ""'
expect_refusal "a translated state with an empty value" 1 "Localizable.xcstrings: brand.name has no en translation"

fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["brand.name"]["localizations"]["fr"]["stringUnit"]["state"] = "new"'
expect_refusal "an untranslated French string" 1 "Localizable.xcstrings: brand.name has no fr translation"

# The sign-out hint states the per-client sign-out rule: a hint that says "this device" again is refused, in each language.
fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["session.sign_out_hint"]["localizations"]["fr"]["stringUnit"]["value"] = "Ferme la session sur cet appareil."'
expect_refusal "a French sign-out hint that no longer says every device" 1 \
  "Localizable.xcstrings: session.sign_out_hint (fr) must read \"Vous déconnecte de l'application Kodera sur tous vos appareils Apple.\""

fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["session.sign_out_hint"]["localizations"]["en"]["stringUnit"]["value"] = "Ends the session on this device."'
expect_refusal "an English sign-out hint that no longer says every device" 1 \
  "Localizable.xcstrings: session.sign_out_hint (en) must read \"Signs you out of the Kodera app on all your Apple devices.\""

# input.clear is required copy AND referenced from App/, so both guards speak.
fresh; edit_json Resources/Localizable.xcstrings 'del d["strings"]["input.clear"]'
expect_refusal "missing required accessible copy" 2 \
  "Localizable.xcstrings lacks required accessible copy input.clear"

fresh; printf '\nlet unlisted = "login.not_in_catalogue"\n' >> "$work/App/KoderaApp.swift"
expect_refusal "a referenced key the catalogue lacks" 1 \
  "Localizable.xcstrings lacks login.not_in_catalogue, referenced in App/"

# Anywhere in App/**, not only App/*.
fresh; mkdir -p "$work/App/Sub"; printf 'let k = "login.not_in_catalogue"\n' > "$work/App/Sub/X.swift"
expect_refusal "a referenced key in a subdirectory the catalogue lacks" 1 \
  "Localizable.xcstrings lacks login.not_in_catalogue, referenced in App/"

# The prefixes come from the catalogue: a new one is covered without editing the check.
fresh; edit_json Resources/Localizable.xcstrings \
  'd["strings"]["signin.title"] = d["strings"]["brand.name"]'
printf 'let k = "signin.missing"\n' > "$work/App/Sub.swift"
expect_refusal "a referenced key under a prefix new to the catalogue" 1 \
  "Localizable.xcstrings lacks signin.missing, referenced in App/"

# ── fonts and licences ─────────────────────────────────────────────────────
fresh; edit_plist Info.plist 'd["UIAppFonts"] = d["UIAppFonts"][:-1]'
expect_refusal "a font that is not registered" 1 \
  "Info.plist UIAppFonts differs from Resources/Fonts/manifest.json"

fresh; printf 'x' >> "$work/App/Resources/Fonts/IBMPlexMono-Regular.ttf"
expect_refusal "a font that drifted from its manifest" 1 \
  "font IBMPlexMono-Regular.ttf differs from its manifest hash"

fresh; rm -- "$work/App/Resources/Licenses/OFL-plus-jakarta-sans.txt"
expect_refusal "a missing licence notice" 1 \
  "expected 2 OFL font licence notices in Resources/Licenses, found 1"

# ── Info.plist capabilities and deployment ────────────────────────────────
fresh; edit_plist Info.plist 'del d["NSBluetoothAlwaysUsageDescription"]'
expect_refusal "missing Bluetooth consent description" 1 \
  "Info.plist lacks the foreground proximity permission description NSBluetoothAlwaysUsageDescription"

fresh; edit_json Resources/InfoPlist.xcstrings 'del d["strings"]["NSLocalNetworkUsageDescription"]["localizations"]["fr"]'
expect_refusal "missing local-network consent translation" 1 \
  "InfoPlist.xcstrings: NSLocalNetworkUsageDescription has no fr translation"

fresh; edit_plist Info.plist 'd["NSBonjourServices"] = ["_http._tcp"]'
expect_refusal "unexpected Bonjour service" 1 \
  "Info.plist must declare only the foreground proximity Bonjour service"

fresh; edit_plist Info.plist 'd["NSLocationWhenInUseUsageDescription"] = "Unexpected location request"'
expect_refusal "location permission is not proximity" 1 \
  "Info.plist requests location access; proximity uses no location permission"

fresh; edit_plist Info.plist 'd["CFBundleURLTypes"] = [{"CFBundleURLSchemes": ["io.kodera.app"]}]'
expect_refusal "a registered callback scheme" 1 \
  "Info.plist declares CFBundleURLTypes, a capability this app has not qualified"

fresh; edit_plist Info.plist 'd["NSAppTransportSecurity"] = {"NSAllowsArbitraryLoads": True}'
expect_refusal "relaxed transport security" 1 \
  "Info.plist declares NSAppTransportSecurity, a capability this app has not qualified"

fresh; edit_plist Info.plist 'd["UIBackgroundModes"] = ["fetch"]'
expect_refusal "declared background modes" 1 \
  "Info.plist declares UIBackgroundModes, a capability this app has not qualified"

# Deployment keys are allowed only as their own build-setting reference.
fresh; edit_plist Info.plist 'd["KoderaCoreOrigin"] = "https://core.example"'
expect_refusal "a literal Core origin" 1 \
  "Info.plist sets KoderaCoreOrigin to a literal; only the build-setting reference \$(KODERA_CORE_ORIGIN) is allowed"

fresh; edit_plist Info.plist 'd["KoderaIssuerOrigins"] = "https://id.example"'
expect_refusal "literal issuer origins" 1 \
  "Info.plist sets KoderaIssuerOrigins to a literal; only the build-setting reference \$(KODERA_ISSUER_ORIGINS) is allowed"

fresh; edit_plist Info.plist 'd["KoderaClientID"] = "kodera-ios"'
expect_refusal "a literal client ID" 1 \
  "Info.plist sets KoderaClientID to a literal; only the build-setting reference \$(KODERA_IOS_CLIENT_ID) is allowed"

fresh; edit_plist Info.plist 'd["KoderaClientID"] = "$(KODERA_CORE_ORIGIN)"'
expect_refusal "a client ID that references another setting" 1 \
  "Info.plist sets KoderaClientID to a literal; only the build-setting reference \$(KODERA_IOS_CLIENT_ID) is allowed"

fresh; edit_plist Info.plist 'd["KoderaDevelopmentIssuer"] = "http://localhost:8080/realms/kodera-dev"'
expect_refusal "a literal development issuer" 1 \
  "Info.plist sets KoderaDevelopmentIssuer to a literal; only the build-setting reference \$(KODERA_DEV_ISSUER) is allowed"

fresh; edit_plist Info.plist 'd["KoderaOfflineAccess"] = "YES"'
expect_refusal "a literal offline-access switch" 1 \
  "Info.plist sets KoderaOfflineAccess to a literal; only the build-setting reference \$(KODERA_OFFLINE_ACCESS) is allowed"

fresh; edit_plist Info.plist 'd["KoderaConsoleOrigin"] = "https://console.example"'
expect_refusal "a literal Console origin" 1 \
  "Info.plist sets KoderaConsoleOrigin to a literal; only the build-setting reference \$(KODERA_CONSOLE_ORIGIN) is allowed"

fresh; edit_plist Info.plist 'del d["KoderaIssuerOrigins"]'
expect_refusal "a deployment key that is missing" 1 \
  "Info.plist lacks KoderaIssuerOrigins; it must be the build-setting reference \$(KODERA_ISSUER_ORIGINS)"

# ── Config/ ────────────────────────────────────────────────────────────────
fresh; set_line Kodera.xcconfig KODERA_CORE_ORIGIN 'KODERA_CORE_ORIGIN = https:/$()/core.example'
expect_refusal "a committed Core origin" 1 \
  "Config/Kodera.xcconfig gives KODERA_CORE_ORIGIN a value; committed deployment settings stay empty"

fresh; printf 'KODERA_IOS_CLIENT_ID[sdk=iphoneos*] = kodera-ios\n' >> "$work/Config/Kodera.xcconfig"
expect_refusal "a committed client ID behind a condition" 1 \
  "Config/Kodera.xcconfig gives KODERA_IOS_CLIENT_ID a value; committed deployment settings stay empty"

fresh; set_line Kodera.xcconfig KODERA_ISSUER_ORIGINS '// removed'
expect_refusal "a deployment setting the base file does not declare" 1 \
  "Config/Kodera.xcconfig does not declare KODERA_ISSUER_ORIGINS"

fresh; set_line Kodera.xcconfig KODERA_OFFLINE_ACCESS 'KODERA_OFFLINE_ACCESS = YES'
expect_refusal "offline access switched on in the committed base file" 1 \
  "Config/Kodera.xcconfig gives KODERA_OFFLINE_ACCESS a value; committed deployment settings stay empty"

fresh; set_line Kodera.xcconfig KODERA_OFFLINE_ACCESS '// removed'
expect_refusal "an offline-access setting the base file does not declare" 1 \
  "Config/Kodera.xcconfig does not declare KODERA_OFFLINE_ACCESS"

fresh; set_line Kodera.xcconfig KODERA_CONSOLE_ORIGIN 'KODERA_CONSOLE_ORIGIN = https:/$()/console.example'
expect_refusal "a committed Console origin" 1 \
  "Config/Kodera.xcconfig gives KODERA_CONSOLE_ORIGIN a value; committed deployment settings stay empty"

fresh; sed -i.bak '/^#include? /d' "$work/Config/Kodera.xcconfig"
expect_refusal "a base file that never reads Local.xcconfig" 1 \
  'Config/Kodera.xcconfig does not include? "Local.xcconfig" on a line of its own'

# A comment that quotes the include is not the include.
fresh; sed -i.bak 's|^#include? |// #include? |' "$work/Config/Kodera.xcconfig"
expect_refusal "an include that is only quoted in a comment" 1 \
  'Config/Kodera.xcconfig does not include? "Local.xcconfig" on a line of its own'

fresh; sed -i.bak 's|^#include? "Local.xcconfig"$|#include? "Local.xcconfig.example"|' "$work/Config/Kodera.xcconfig"
expect_refusal "an include of another file" 1 \
  'Config/Kodera.xcconfig does not include? "Local.xcconfig" on a line of its own'

fresh; sed -i.bak '/^KODERA_DEV_ISSUER\[config=Release\]/d' "$work/Config/Kodera.xcconfig"
expect_refusal "a base file without the Release override" 1 \
  "Config/Kodera.xcconfig lacks the line KODERA_DEV_ISSUER[config=Release] ="

fresh; sed -i.bak 's|^KODERA_DEV_ISSUER\[config=Release\] =|// KODERA_DEV_ISSUER[config=Release] =|' "$work/Config/Kodera.xcconfig"
expect_refusal "a Release override that is only quoted in a comment" 1 \
  "Config/Kodera.xcconfig lacks the line KODERA_DEV_ISSUER[config=Release] ="

fresh; python3 - "$work/Config/Kodera.xcconfig" <<'PY3'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
override = next(i for i, line in enumerate(lines) if line.startswith("KODERA_DEV_ISSUER[config=Release]"))
line = lines.pop(override)
include = next(i for i, line in enumerate(lines) if line.startswith("#include? "))
lines.insert(include, line)
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY3
expect_refusal "a Release override that Local.xcconfig can still override" 1 \
  "Config/Kodera.xcconfig empties KODERA_DEV_ISSUER for Release before it includes Local.xcconfig"

fresh; set_line Local.xcconfig.example KODERA_ISSUER_ORIGINS 'KODERA_ISSUER_ORIGINS = https:/$()/auth.kodera.io'
expect_refusal "a real issuer origin in the example" 1 \
  "Config/Local.xcconfig.example sets KODERA_ISSUER_ORIGINS to a value that is not loopback-only"

fresh; set_line Local.xcconfig.example KODERA_ISSUER_ORIGINS \
  'KODERA_ISSUER_ORIGINS = http:/$()/localhost:8080 https:/$()/auth.kodera.io'
expect_refusal "a real issuer origin after a loopback one" 1 \
  "Config/Local.xcconfig.example sets KODERA_ISSUER_ORIGINS to a value that is not loopback-only"

fresh; set_line Local.xcconfig.example KODERA_CORE_ORIGIN 'KODERA_CORE_ORIGIN = http:/$()/localhost.evil.test:8000'
expect_refusal "a lookalike loopback Core origin in the example" 1 \
  "Config/Local.xcconfig.example sets KODERA_CORE_ORIGIN to a value that is not loopback-only"

fresh; set_line Local.xcconfig.example KODERA_IOS_CLIENT_ID 'KODERA_IOS_CLIENT_ID = https:/$()/x'
expect_refusal "a client ID that is not an identifier in the example" 1 \
  "Config/Local.xcconfig.example sets KODERA_IOS_CLIENT_ID to a value that is not loopback-only"

fresh; set_line Local.xcconfig.example KODERA_OFFLINE_ACCESS 'KODERA_OFFLINE_ACCESS = https:/$()/x'
expect_refusal "an offline-access switch that is not YES or NO in the example" 1 \
  "Config/Local.xcconfig.example sets KODERA_OFFLINE_ACCESS to a value that is not loopback-only"

fresh; set_line Local.xcconfig.example KODERA_CONSOLE_ORIGIN 'KODERA_CONSOLE_ORIGIN = https:/$()/console.kodera.io'
expect_refusal "a real Console origin in the example" 1 \
  "Config/Local.xcconfig.example sets KODERA_CONSOLE_ORIGIN to a value that is not loopback-only"

# ── KODERA_ settings outside the two files ─────────────────────────────────
fresh; python3 - "$work/project.yml" <<'PY4'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
anchor = "        PRODUCT_BUNDLE_IDENTIFIER: io.kodera.app\n"
assert anchor in text, "project.yml anchor moved"
open(path, "w", encoding="utf-8").write(text.replace(anchor, anchor + "        KODERA_CORE_ORIGIN: core.example\n", 1))
PY4
expect_refusal "a deployment setting in project.yml" 1 \
  "project.yml sets a KODERA_ value; deployment settings live only in Config/Kodera.xcconfig"

fresh; printf '# KODERA_CORE_ORIGIN is set in Config/Kodera.xcconfig\n' >> "$work/project.yml"
expect_clean "project.yml may name a setting in a comment"

fresh; printf 'KODERA_IOS_CLIENT_ID = kodera-ios\n' > "$work/Config/Staging.xcconfig"
expect_refusal "a deployment setting in another committed xcconfig" 1 \
  "Config/Staging.xcconfig sets KODERA_IOS_CLIENT_ID; deployment settings live only in Config/Kodera.xcconfig"

fresh; mkdir -p "$work/App/Build"; printf 'KODERA_CORE_ORIGIN[config=Release] = core.example\n' > "$work/App/Build/Extra.xcconfig"
expect_refusal "a deployment setting in a nested xcconfig" 1 \
  "App/Build/Extra.xcconfig sets KODERA_CORE_ORIGIN; deployment settings live only in Config/Kodera.xcconfig"

# The developer's own untracked file is where the values go.
fresh; printf 'KODERA_CORE_ORIGIN = https:/$()/core.example\n' > "$work/Config/Local.xcconfig"
expect_clean "a developer's untracked Config/Local.xcconfig is not refused"

# ── deployment literals in App/**/*.swift ──────────────────────────────────
fresh; printf '\nlet fallbackCore = "https://core.example"\n' >> "$work/App/Configuration.swift"
expect_refusal "a hard-coded endpoint" 1 \
  "App/Configuration.swift:$(( $(wc -l < "$root/App/Configuration.swift") + 2 )) carries an http(s):// literal"

fresh; mkdir -p "$work/App/Sub"; printf 'let core = "http://localhost:8000"\n' > "$work/App/Sub/X.swift"
expect_refusal "a hard-coded loopback endpoint in a subdirectory" 1 \
  "App/Sub/X.swift:1 carries an http(s):// literal; endpoints come only from build settings"

fresh; printf 'let core = "HTTPS://core.example"\n' > "$work/App/X.swift"
expect_refusal "an endpoint in upper case" 1 "App/X.swift:1 carries an http(s):// literal"

fresh; printf 'let clientId = "abc"\n' > "$work/App/X.swift"
expect_refusal "a hard-coded clientId" 1 "App/X.swift:1 hard-codes a client ID"

fresh; printf 'let x = configure(clientID: "abc")\n' > "$work/App/X.swift"
expect_refusal "a client ID literal passed as clientID:" 1 "App/X.swift:1 hard-codes a client ID"

fresh; printf 'let CLIENT_ID = "abc"\n' > "$work/App/X.swift"
expect_refusal "a client ID literal in another case" 1 "App/X.swift:1 hard-codes a client ID"

fresh; printf 'let name = "Kodera-Android"\n' > "$work/App/X.swift"
expect_refusal "a platform client name" 1 "App/X.swift:1 hard-codes a client ID"

fresh; printf 'let x = 1\nlet c = CoreRequester(\n    "core.example")\n' > "$work/App/X.swift"
expect_refusal "a literal passed to a deployment constructor across lines" 1 \
  "App/X.swift:2 passes a string literal to a deployment constructor"

fresh; printf 'let c = CoreDiscoveryConfiguration(origins: ["id.example"])\n' > "$work/App/X.swift"
expect_refusal "an array literal passed to a deployment constructor" 1 \
  "App/X.swift:1 passes a string literal to a deployment constructor"

fresh; printf 'let c = SignInConfiguration(clientID: "abc")\n' > "$work/App/X.swift"
expect_refusal "a client ID literal passed to SignInConfiguration (two clauses speak)" 2 \
  "App/X.swift:1 passes a string literal to a deployment constructor"

fresh; printf 'let c = make(base, coreApiOrigin: "core.example")\n' > "$work/App/X.swift"
expect_refusal "a literal Core origin argument" 1 "App/X.swift:1 passes a string literal as a deployment argument"

fresh; printf 'let c = make(base,\n    admittedIssuerOrigins: [ "id.example"])\n' > "$work/App/X.swift"
expect_refusal "a literal issuer origins argument" 1 "App/X.swift:2 passes a string literal as a deployment argument"

# ── design literals outside App/Generated/ ─────────────────────────────────
# App/Generated/KoderaTokens.swift itself writes hundreds of colour literals, so
# the clean run above is what proves the generated directory is exempt.
fresh; printf 'let tint = Color(red: 0.2, green: 0.3, blue: 0.9)\n' > "$work/App/Literal.swift"
expect_refusal "a colour component literal" 1 \
  "App/Literal.swift:1 writes a colour component literal; use the generated tokens"

fresh; printf 'let tint = Color(#colorLiteral(red: 1, green: 0, blue: 0, alpha: 1))\n' > "$work/App/Literal.swift"
expect_refusal "a colour literal" 1 "App/Literal.swift:1 writes a colour literal; use the generated tokens"

# In a subdirectory: the scan covers App/**, not only App/*.
fresh; mkdir -p "$work/App/Features"; printf 'let f = Font.system(size: 14)\n' > "$work/App/Features/Literal.swift"
expect_refusal "a system font size in a subdirectory" 1 \
  "App/Features/Literal.swift:1 writes a system font size; use the generated tokens"

fresh; printf 'let f = Font.custom(FontAssets.sansBold, size: 17, relativeTo: .body)\n' > "$work/App/Literal.swift"
expect_refusal "a literal custom font size" 1 \
  "App/Literal.swift:1 writes a literal custom font size; use the generated tokens"

# Every other branch of each family, alone: INPUT|FAMILY.
literal_cases=(
  'UIColor(red: 1, green: 0, blue: 0, alpha: 1)|a colour component literal'
  'Color(.sRGB, red: 0.2, green: 0.3, blue: 0.9, opacity: 1)|a colour component literal'
  'Color(.sRGBLinear, red: 0.2, green: 0.3, blue: 0.9, opacity: 1)|a colour component literal'
  'Color(.displayP3, red: 0.2, green: 0.3, blue: 0.9, opacity: 1)|a colour component literal'
  'Color(hue: 0.6, saturation: 0.5, brightness: 0.9)|a colour component literal'
  'Color(white: 0.5)|a colour component literal'
  'UIColor(displayP3Red: 1, green: 0, blue: 0, alpha: 1)|a colour component literal'
  'Font.system( size: 14)|a system font size'
  'UIFont.systemFont(ofSize: 14)|a system font size'
  'UIFont.boldSystemFont(ofSize: 14)|a system font size'
  'UIFont.italicSystemFont(ofSize: 14)|a system font size'
  'UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)|a system font size'
  'UIFont(name: FontAssets.sansBold, size: 17)|a literal custom font size'
  'Font.custom(FontAssets.sansBold, fixedSize: 17)|a literal custom font size'
)
for entry in "${literal_cases[@]}"; do
  fresh; printf 'let x = %s\n' "${entry%%|*}" > "$work/App/Literal.swift"
  expect_refusal "${entry#*|}: ${entry%%|*}" 1 \
    "App/Literal.swift:1 writes ${entry#*|}; use the generated tokens"
done

# ── companion surface ──────────────────────────────────────────────────────
# The app sells nothing: no commercial wording, no price, no billing provider,
# no billing address, and no page opened outside sign-in. Each reintroduction
# is refused for its own reason.
SOLD="; the app sells nothing and links to no billing page"
set_copy() {
  edit_json Resources/Localizable.xcstrings "d['strings']['$1']['localizations']['$2']['stringUnit']['value'] = '$3'"
}

fresh; set_copy proximity.prepare en 'Upgrade to check in'
expect_refusal "an upgrade prompt in the English copy" 1 \
  "Localizable.xcstrings: proximity.prepare (en) carries commercial wording (\"Upgrade\")$SOLD"

fresh; set_copy proximity.prepare fr 'Passez à un abonnement'
expect_refusal "commercial wording in the French copy" 1 \
  "Localizable.xcstrings: proximity.prepare (fr) carries commercial wording (\"abonnement\")$SOLD"

fresh; set_copy session.no_organisation en 'See pricing on the web.'
expect_refusal "a pricing pointer in the no-organisation copy" 1 \
  "Localizable.xcstrings: session.no_organisation (en) carries commercial wording (\"pricing\")$SOLD"

fresh; set_copy proximity.description en 'Choose a plan to continue.'
expect_refusal "plan wording in the copy" 1 \
  "Localizable.xcstrings: proximity.description (en) carries commercial wording (\"plan\")$SOLD"

fresh; set_copy proximity.description en 'Manage your subscription.'
expect_refusal "subscription wording in the copy" 1 \
  "Localizable.xcstrings: proximity.description (en) carries commercial wording (\"subscription\")$SOLD"

fresh; set_copy proximity.description fr 'Seulement 9 € par appareil.'
expect_refusal "a price in the copy" 1 \
  "Localizable.xcstrings: proximity.description (fr) states a price (\"9 €\")$SOLD"

fresh; set_copy proximity.description en 'Only $4 each.'
expect_refusal "a dollar price in the copy" 1 \
  "Localizable.xcstrings: proximity.description (en) states a price (\"\$4\")$SOLD"

fresh; edit_json Resources/Localizable.xcstrings 'd["strings"]["offer.checkout"] = d["strings"]["proximity.cancel"]'
expect_refusal "a checkout key in the catalogue" 1 \
  "Localizable.xcstrings: offer.checkout carries commercial wording (\"checkout\")$SOLD"

fresh; edit_plist Info.plist 'd["NSHumanReadableCopyright"] = "Premium features available"'
expect_refusal "commercial wording in Info.plist" 1 "Info.plist carries commercial wording (\"Premium\")$SOLD"

fresh; printf '// Shows the paywall when the trial ends.\nlet shown = true\n' > "$work/App/Offer.swift"
expect_refusal "a paywall in app code" 1 "App/Offer.swift:1 carries commercial wording (\"paywall\")$SOLD"

fresh; mkdir -p "$work/App/Features"; printf 'let ready = true\nfunc openCheckout() {}\n' > "$work/App/Features/Offer.swift"
expect_refusal "a checkout action inside an identifier, in a subdirectory" 1 \
  "App/Features/Offer.swift:2 carries commercial wording (\"Checkout\")$SOLD"

fresh; printf 'import StoreKit\n' > "$work/App/Offer.swift"
expect_refusal "a store purchase API in app code" 1 \
  "App/Offer.swift:1 names a billing provider or store purchase API (\"StoreKit\")$SOLD"

fresh; printf 'let path = "/plans"\n' > "$work/App/Offer.swift"
expect_refusal "a billing path in app code" 1 "App/Offer.swift:1 names a billing destination (\"\"/plans\"\")$SOLD"

fresh; printf 'let label = "9 EUR"\n' > "$work/App/Offer.swift"
expect_refusal "a price in app code" 1 "App/Offer.swift:1 states a price (\"9 EUR\")$SOLD"

# The Console action this app no longer has: any page opened from App/ is refused.
open_cases=(
  '@Environment(\.openURL) private var openURL|openURL'
  'UIApplication.shared.open(console)|UIApplication.shared.open'
  'Link("Console", destination: console)|Link('
  'SFSafariViewController(url: console)|SFSafariViewController'
  'WKWebView(frame: .zero)|WKWebView'
  'ASWebAuthenticationSession(url: console, callbackURLScheme: nil) { _, _ in }|ASWebAuthenticationSession'
)
for entry in "${open_cases[@]}"; do
  fresh; printf 'let ready = true\n%s\n' "${entry%%|*}" > "$work/App/Offer.swift"
  expect_refusal "a page opened outside the app: ${entry#*|}" 1 \
    "App/Offer.swift:2 opens a page outside the app (\"${entry#*|}\")$SOLD"
done

fresh; printf '\n# packages: RevenueCat\n' >> "$work/project.yml"
expect_refusal "a billing provider in project.yml" 1 \
  "project.yml:$(($(wc -l < "$root/project.yml") + 2)) names a billing provider or store purchase API (\"RevenueCat\")$SOLD"

fresh; printf '\n// StoreKit products\n' >> "$work/packages/KoderaClient/Sources/KoderaClient/CoreMeClient.swift"
expect_refusal "a store purchase API in a package source" 1 \
  "packages/KoderaClient/Sources/KoderaClient/CoreMeClient.swift:$(($(wc -l < "$root/packages/KoderaClient/Sources/KoderaClient/CoreMeClient.swift") + 2)) names a billing provider or store purchase API (\"StoreKit\")$SOLD"

fresh; printf '\nlet invoices = "/invoices"\n' >> "$work/packages/KoderaDomain/Sources/KoderaDomain/ConsoleOrigin.swift"
expect_refusal "a billing path in a package source" 1 \
  "packages/KoderaDomain/Sources/KoderaDomain/ConsoleOrigin.swift:$(($(wc -l < "$root/packages/KoderaDomain/Sources/KoderaDomain/ConsoleOrigin.swift") + 2)) names a billing destination (\"\"/invoices\"\")$SOLD"

fresh; printf '\n// A paywall would live here.\n' >> "$work/packages/KoderaAuth/Sources/KoderaAuth/AppConfiguration.swift"
expect_refusal "a paywall in a package source" 1 \
  "packages/KoderaAuth/Sources/KoderaAuth/AppConfiguration.swift:$(($(wc -l < "$root/packages/KoderaAuth/Sources/KoderaAuth/AppConfiguration.swift") + 2)) carries commercial wording (\"paywall\")$SOLD"

fresh; printf '\n// .package(name: "Paddle")\n' >> "$work/packages/KoderaClient/Package.swift"
expect_refusal "a billing provider in a package manifest" 1 \
  "packages/KoderaClient/Package.swift:$(($(wc -l < "$root/packages/KoderaClient/Package.swift") + 2)) names a billing provider or store purchase API (\"Paddle\")$SOLD"

# ── could not look ─────────────────────────────────────────────────────────
# expect_unreadable LABEL — after the mutation was applied.
expect_unreadable() {
  run
  printf '%s\n' "$_out" | grep -qF "Nothing was checked." || fail "$1 was not reported as unreadable
  actual output: $_out"
  [ "$_status" -eq 2 ] || fail "$1 exited $_status, not 2
  actual output: $_out"
  cases=$((cases + 1))
  printf '  ok  %s\n' "$1 is 'could not look' (exit 2), not clean"
}

fresh; rm -- "$work/App/Generated/TokenProvenance.json"
expect_unreadable "a missing input"

fresh; printf '{"strings": ' > "$work/App/Resources/Localizable.xcstrings"
expect_unreadable "an invalid JSON catalogue"

fresh; printf 'not a property list' > "$work/App/Info.plist"
expect_unreadable "an invalid Info.plist"

fresh; rm -- "$work/Config/Local.xcconfig.example"
expect_unreadable "a missing Config/Local.xcconfig.example"

fresh; rm -- "$work/project.yml"
expect_unreadable "a missing project.yml"

fresh; rm -r -- "$work/packages"
expect_unreadable "missing Swift packages"

fresh
expect_clean "the copy passes again once restored"

# A harness that aborted early, or a case list that shrank, must not pass.
expected_cases=119
[ "$cases" -eq "$expected_cases" ] || fail "ran $cases cases, expected $expected_cases"
echo "self-test passed: $cases cases, each proved by its own message, finding count AND exit status"

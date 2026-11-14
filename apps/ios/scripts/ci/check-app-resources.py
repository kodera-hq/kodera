#!/usr/bin/env python3
"""Refuse app resources that Xcode would build without complaint.

Xcode does not fail a build on any of these, and each ships silently:

- generated tokens edited by hand, or regenerated from an unqualified producer;
- an untranslated string, or a key the code references that the catalogue lacks;
- a font file that drifted from its manifest, or one that is not registered;
- a missing font licence notice;
- an Info.plist that opens a callback scheme (CFBundleURLTypes), relaxes
  transport security, or declares background modes;
- a deployment key (Core origin, issuer origins, client ID, development
  issuer, offline access, Console origin) in Info.plist that is anything but its $(KODERA_…)
  build-setting reference — the checked-in app is unconfigured by design, and
  deployment values come only from build settings supplied outside the
  repository;
- a committed Config/Kodera.xcconfig that gives a deployment setting a value,
  that does not include Local.xcconfig on a line of its own, or that lacks
  the Release override emptying KODERA_DEV_ISSUER after that include;
- a Config/Local.xcconfig.example whose values are not loopback-only;
- a KODERA_ setting in project.yml or in any .xcconfig but those two (the
  untracked Config/Local.xcconfig excepted);
- in any App/**/*.swift: an http:// or https:// literal (any case), a client
  ID literal (`clientID: "…"`, any case, or "kodera-ios"/"kodera-android"),
  or a string literal passed to SignInConfiguration, CoreRequester or
  CoreDiscoveryConfiguration, or as a coreApiOrigin/admittedIssuerOrigins
  argument;
- a colour or font literal in App/ outside App/Generated/ (design values come
  only from the generated tokens and FontAssets);
- anything commercial: pricing, plan, upgrade, checkout, invoice, payment or
  subscription wording (English or French) or a price in the catalogue or
  Info.plist; such wording, a billing provider, a store purchase API or a
  billing address in App/**/*.swift, project.yml or the Swift packages; and
  any call in App/ that opens a page outside the app (openURL, Link, a web
  view). The app is a companion: it sells nothing, and sign-in, inside
  KoderaAuth, is the only page it opens in a browser.

Usage: check-app-resources.py [REPOSITORY_ROOT]   (default: .)
Exit 0: clean. Exit 1: findings, one `::error::` line each. Exit 2: an input
could not be read, so nothing was decided.
"""

import hashlib
import json
import plistlib
import re
import sys
from pathlib import Path

# The qualified token producer. Regenerating the tokens from another revision
# is a deliberate act: update this pin in the same change.
TOKEN_FORMAT = "kodera-native-tokens/1"
TOKEN_PRODUCER_COMMIT = "cf4e10dbd9aaab05f65deedfb50ca100fd0e3d73"
TOKEN_SOURCE_SHA256 = "b433e6661de2804471ba3f62715b21b9ef81e218a967bc83ca62132f82161e51"

LANGUAGES = ("fr", "en")
SOURCE_LANGUAGE = "fr"
# Copy that assistive technologies depend on; its absence is not a style issue.
REQUIRED_KEYS = ("organisation.label", "discovery.unavailable", "login.unavailable", "input.clear")
LICENCE_NOTICES = 2
# Copy that states what a security action does. Sign-out revokes this app's grant, which ends
# its sessions on every device of the member, and only this app's: the Android app is another
# client (per OIDC client). The hint must say exactly that in each language. Changing it is a deliberate act: update this pin in the same change.
PINNED_COPY = {
    ("session.sign_out_hint", "fr"): "Vous déconnecte de l'application Kodera sur tous vos appareils Apple.",
    ("session.sign_out_hint", "en"): "Signs you out of the Kodera app on all your Apple devices.",
}

FORBIDDEN_PLIST_KEYS = ("CFBundleURLTypes", "NSAppTransportSecurity", "UIBackgroundModes")
# Each deployment key is present ONLY as the reference to its build setting.
DEPLOYMENT_PLIST_KEYS = {
    "KoderaCoreOrigin": "KODERA_CORE_ORIGIN",
    "KoderaIssuerOrigins": "KODERA_ISSUER_ORIGINS",
    "KoderaClientID": "KODERA_IOS_CLIENT_ID",
    "KoderaDevelopmentIssuer": "KODERA_DEV_ISSUER",
    "KoderaOfflineAccess": "KODERA_OFFLINE_ACCESS",
    "KoderaConsoleOrigin": "KODERA_CONSOLE_ORIGIN",
}
# The committed example may point only at a developer's own machine.
LOOPBACK_VALUE = re.compile(r"(?:http:/\$\(\)/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}(?:/realms/[a-z0-9-]+)?\s*)+")
EXAMPLE_VALUES = {
    "KODERA_IOS_CLIENT_ID": re.compile(r"[a-z0-9-]{1,64}"),
    "KODERA_OFFLINE_ACCESS": re.compile(r"YES|NO"),
}
XCCONFIG_SETTING = re.compile(r"^\s*([A-Z0-9_]+)(\[[^\]]*\])?\s*=\s*(.*?)\s*$")
# The include and the Release override, each on a line of its own: a comment
# that merely quotes them must not satisfy the check.
INCLUDE_LINE = re.compile(r'^#include\? "Local\.xcconfig"', re.MULTILINE)
RELEASE_OVERRIDE_LINE = re.compile(r"^KODERA_DEV_ISSUER\[config=Release\][ \t]*=[ \t]*$", re.MULTILINE)
# Deployment settings live in these two files, and in the untracked Config/Local.xcconfig.
ALLOWED_XCCONFIG = {"Config/Kodera.xcconfig", "Config/Local.xcconfig"}
SKIPPED_DIRECTORIES = {".git", ".build", ".swiftpm", "DerivedData"}

# Deployment values written into app code. Each is matched on the whole file,
# so a call split over several lines is still read.
URL_LITERAL = re.compile(r"https?://", re.IGNORECASE)
CLIENT_ID_LITERAL = re.compile(r'\bclient_?id\s*[:=]\s*"', re.IGNORECASE)
CLIENT_NAME_LITERAL = re.compile(r'"kodera-(?:ios|android)"', re.IGNORECASE)
CONSTRUCTOR_LITERAL = re.compile(
    r'\b(?:SignInConfiguration|CoreRequester|CoreDiscoveryConfiguration)\s*\(\s*(?:[A-Za-z_]\w*\s*:\s*)?[\["]')
ARGUMENT_LITERAL = re.compile(r'\b(?:coreApiOrigin|admittedIssuerOrigins)\s*:\s*\[?\s*"')
CODE_LITERALS = (
    (URL_LITERAL, "carries an http(s):// literal; endpoints come only from build settings"),
    (CLIENT_ID_LITERAL, "hard-codes a client ID"),
    (CLIENT_NAME_LITERAL, "hard-codes a client ID"),
    (CONSTRUCTOR_LITERAL, "passes a string literal to a deployment constructor"),
    (ARGUMENT_LITERAL, "passes a string literal as a deployment argument"),
)

# Design values reach the interface only through App/Generated/. Each family is
# a way to write a colour or a font that bypasses the tokens.
DESIGN_LITERALS = (
    ("a colour component literal",
     re.compile(r"\b(?:UI)?Color\(\s*(?:\.(?:sRGB|sRGBLinear|displayP3)\s*,\s*)?(?:red|hue|white|displayP3Red)\s*:")),
    ("a colour literal", re.compile(r"#colorLiteral\s*\(")),
    ("a system font size",
     re.compile(r"\.system\(\s*size\s*:"
                r"|\bUIFont\.(?:systemFont|boldSystemFont|italicSystemFont|monospacedSystemFont)\(\s*ofSize\s*:")),
    ("a literal custom font size",
     re.compile(r"(?:\.custom|\bUIFont)\([^)\n]*\b(?:fixedS|s)ize\s*:\s*[0-9]")),
)


# Sign-in is the only page the app opens, and KoderaAuth opens it. Nothing in App/ opens another:
# a link out is how a companion app ends up one tap away from a checkout.
EXTERNAL_OPEN = re.compile(
    r"\bopenURL\b|UIApplication\.shared\.open\b|\bLink\s*\(|SFSafariViewController|WKWebView"
    r"|ASWebAuthenticationSession")

# ── companion surface ──────────────────────────────────────────────────────
# The app is a companion to a workspace its organisation already has: no in-app
# purchase, no pricing screen, and no link that can reach a checkout or an
# upgrade page. Stems mean commerce wherever they stand, inside an identifier
# included (`openCheckout`, `show_paywall`); words only on their own.
_LETTER = r"[^\W\d_]"
COMMERCIAL_STEMS = (r"pricing|upgrad(?:e|es|ed|ing)|upsell|checkout|billing|invoic(?:e|es|ed|ing)|payment"
                    r"|purchas(?:e|es|ed|ing)|paywall|premium|tarification|abonnement|facturation|paiement")
COMMERCIAL_WORDS = (r"priced?|prices|billed|pay\s+now|free\s+trial|trial\s+period"
                    r"|(?:paid|pro|business|enterprise)\s+plan|buy(?:\s+now)?|credit\s+card"
                    r"|per\s+(?:seat|user|month)|tarifs?|prix|mise\s+à\s+niveau|s['’]abonner|factures?"
                    r"|achats?|acheter|essai\s+gratuit|carte\s+bancaire|par\s+mois")
# Copy only: in code these are ordinary identifiers (an observer `subscription`, a deployment `plan`).
COPY_STEMS = r"subscri(?:be|bes|bed|ber|bers|ption|ptions)"
COPY_WORDS = r"plans?|forfaits?"


def _words(pattern):
    return rf"(?<!{_LETTER})(?:{pattern})(?!{_LETTER})"


COMMERCIAL_CODE = re.compile(f"{COMMERCIAL_STEMS}|{_words(COMMERCIAL_WORDS)}", re.IGNORECASE)
COMMERCIAL_COPY = re.compile(
    f"{COMMERCIAL_STEMS}|{COPY_STEMS}|{_words(COMMERCIAL_WORDS + '|' + COPY_WORDS)}", re.IGNORECASE)
# Library code keeps its own vocabulary (a session "upgrade" is not a sale); only the unambiguous stems.
COMMERCIAL_LIBRARY = re.compile(r"pricing|paywall|upsell|checkout|billing|in-app\s+purchase", re.IGNORECASE)
# `$` is left to copy: in code it is a closure argument or a string template.
PRICE_CODE = re.compile(r"[€£]\s?\d|\d\s?(?:€|EUR\b|USD\b|GBP\b)")
PRICE_COPY = re.compile(r"[€$£]\s?\d|\d\s?(?:€|EUR\b|USD\b|GBP\b)")
BILLING_SDK = re.compile(
    r"\b(?:stripe|paypal|revenuecat|paddle|storekit|skpaymentqueue|skproduct|billingclient)\b"
    r"|com\.android\.billingclient|com\.android\.vending\.BILLING", re.IGNORECASE)
_BILLING_PATHS = r"billing|checkout|pricing|upgrade|invoices?|orders?|subscriptions?|payments?|plans?"
BILLING_DESTINATION = re.compile(
    rf"""(?:https?:)?//[^\s"'<>)]*\b(?:{_BILLING_PATHS})\b|["'`]/(?:{_BILLING_PATHS})(?:[/?#"'`]|$)""",
    re.IGNORECASE | re.MULTILINE)
COMPANION = "the app sells nothing and links to no billing page"
COPY_RULES = (
    (COMMERCIAL_COPY, "carries commercial wording"),
    (PRICE_COPY, "states a price"),
    (BILLING_SDK, "names a billing provider or store purchase API"),
    (BILLING_DESTINATION, "names a billing destination"),
)
APP_CODE_RULES = (
    (COMMERCIAL_CODE, "carries commercial wording"),
    (PRICE_CODE, "states a price"),
    (BILLING_SDK, "names a billing provider or store purchase API"),
    (BILLING_DESTINATION, "names a billing destination"),
    (EXTERNAL_OPEN, "opens a page outside the app"),
)
LIBRARY_RULES = (
    (COMMERCIAL_LIBRARY, "carries commercial wording"),
    (BILLING_SDK, "names a billing provider or store purchase API"),
    (BILLING_DESTINATION, "names a billing destination"),
)


def companion_findings(where, text, rules, numbered=True):
    """One finding per rule: the first match, quoted, at its line when the text is a file."""
    errors = []
    for pattern, reason in rules:
        match = pattern.search(text)
        if match:
            location = f"{where}:{text.count(chr(10), 0, match.start()) + 1}" if numbered else where
            errors.append(f'{location} {reason} ("{match.group(0)}"); {COMPANION}')
    return errors


class Unreadable(Exception):
    pass


def read_bytes(path):
    try:
        return path.read_bytes()
    except OSError as exc:
        raise Unreadable(f"cannot read {path}: {exc.strerror}") from exc


def read_json(path):
    try:
        return json.loads(read_bytes(path))
    except ValueError as exc:
        raise Unreadable(f"{path} is not valid JSON: {exc}") from exc


def sha256(path):
    return hashlib.sha256(read_bytes(path)).hexdigest()


def xcconfig_settings(path):
    """(name, condition, value) for every assignment line, comments stripped."""
    settings = []
    for line in read_bytes(path).decode("utf-8", "replace").splitlines():
        line = line.split("//", 1)[0]
        match = XCCONFIG_SETTING.match(line)
        if match:
            settings.append(match.groups())
    return settings


def config_findings(config):
    errors = []
    base = xcconfig_settings(config / "Kodera.xcconfig")
    names = set(DEPLOYMENT_PLIST_KEYS.values())
    for setting in sorted(names - {name for name, _, _ in base}):
        errors.append(f"Config/Kodera.xcconfig does not declare {setting}")
    for name, _, value in base:
        if name in names and value:
            errors.append(f"Config/Kodera.xcconfig gives {name} a value; committed deployment settings stay empty")
    text = read_bytes(config / "Kodera.xcconfig").decode("utf-8", "replace")
    include = INCLUDE_LINE.search(text)
    if not include:
        errors.append('Config/Kodera.xcconfig does not include? "Local.xcconfig" on a line of its own')
    override = RELEASE_OVERRIDE_LINE.search(text)
    if not override:
        errors.append("Config/Kodera.xcconfig lacks the line KODERA_DEV_ISSUER[config=Release] =")
    elif include and override.start() < include.start():
        errors.append("Config/Kodera.xcconfig empties KODERA_DEV_ISSUER for Release before it includes Local.xcconfig")
    for name, _, value in xcconfig_settings(config / "Local.xcconfig.example"):
        if name not in names:
            continue
        pattern = EXAMPLE_VALUES.get(name, LOOPBACK_VALUE)
        if not pattern.fullmatch(value):
            errors.append(f"Config/Local.xcconfig.example sets {name} to a value that is not loopback-only")
    return errors


def stray_setting_findings(root):
    """KODERA_ settings anywhere but the two files that may carry them."""
    errors = []
    for line in read_bytes(root / "project.yml").decode("utf-8", "replace").splitlines():
        if "KODERA_" in line.split("#", 1)[0]:
            errors.append("project.yml sets a KODERA_ value; deployment settings live only in Config/Kodera.xcconfig")
            break
    for path in sorted(root.rglob("*.xcconfig")):
        relative = path.relative_to(root)
        if SKIPPED_DIRECTORIES.intersection(relative.parts) or relative.as_posix() in ALLOWED_XCCONFIG:
            continue
        for name, _, _ in xcconfig_settings(path):
            if name.startswith("KODERA_"):
                errors.append(f"{relative.as_posix()} sets {name}; deployment settings live only in Config/Kodera.xcconfig")
    return errors


def findings(root):
    app = root / "App"
    errors = config_findings(root / "Config")
    errors += stray_setting_findings(root)

    pin = read_json(app / "Generated/TokenProvenance.json")
    tokens = app / "Generated/KoderaTokens.swift"
    if sha256(tokens) != pin.get("generatedSha256"):
        errors.append("App/Generated/KoderaTokens.swift differs from TokenProvenance.json generatedSha256; regenerate it, do not edit it")
    if pin.get("format") != TOKEN_FORMAT:
        errors.append(f"TokenProvenance.json format is not {TOKEN_FORMAT}")
    if pin.get("producerCommit") != TOKEN_PRODUCER_COMMIT:
        errors.append("TokenProvenance.json producerCommit is not the qualified token producer")
    source_sha = pin.get("sourceSha256")
    if source_sha != TOKEN_SOURCE_SHA256 or source_sha not in read_bytes(tokens).decode("utf-8", "replace"):
        errors.append("KoderaTokens.swift does not carry the sourceSha256 recorded in TokenProvenance.json")

    catalogue = read_json(app / "Resources/Localizable.xcstrings")
    strings = catalogue.get("strings", {})
    if catalogue.get("sourceLanguage") != SOURCE_LANGUAGE:
        errors.append(f"Localizable.xcstrings sourceLanguage is not {SOURCE_LANGUAGE}")
    for key, entry in sorted(strings.items()):
        for lang in LANGUAGES:
            unit = (entry or {}).get("localizations", {}).get(lang, {}).get("stringUnit", {})
            if unit.get("state") != "translated" or not unit.get("value"):
                errors.append(f"Localizable.xcstrings: {key} has no {lang} translation")
    for (key, lang), want in PINNED_COPY.items():
        value = (strings.get(key) or {}).get("localizations", {}).get(lang, {}).get("stringUnit", {}).get("value")
        if value is not None and value != want:
            errors.append(f"Localizable.xcstrings: {key} ({lang}) must read \"{want}\"")
    for key in REQUIRED_KEYS:
        if key not in strings:
            errors.append(f"Localizable.xcstrings lacks required accessible copy {key}")
    # A quoted string under one of the catalogue's own key prefixes is a key
    # reference, wherever it sits in App/: a new feature folder or a new prefix
    # is covered without editing this check. The required keys' prefixes are
    # always included, so deleting a prefix's last key still finds its users.
    # (Not every dotted string is a key: "info.circle" is an SF Symbol.)
    prefixes = sorted({key.split(".", 1)[0] for key in [*strings, *REQUIRED_KEYS] if "." in key})
    referenced = re.compile(r'"((?:' + "|".join(map(re.escape, prefixes)) + r')\.[a-z0-9_.]+)"')
    used = set()
    for source in sorted(app.rglob("*.swift")):
        used.update(referenced.findall(read_bytes(source).decode("utf-8", "replace")))
    for key in sorted(used - set(strings)):
        errors.append(f"Localizable.xcstrings lacks {key}, referenced in App/")

    try:
        info = plistlib.loads(read_bytes(app / "Info.plist"))
    except plistlib.InvalidFileException as exc:
        raise Unreadable(f"App/Info.plist is not a valid property list: {exc}") from exc
    fonts = read_json(app / "Resources/Fonts/manifest.json").get("fonts", [])
    if set(info.get("UIAppFonts", [])) != {"Fonts/" + f["file"] for f in fonts}:
        errors.append("Info.plist UIAppFonts differs from Resources/Fonts/manifest.json")
    for font in fonts:
        if sha256(app / "Resources/Fonts" / font["file"]) != font["sha256"]:
            errors.append(f"font {font['file']} differs from its manifest hash")
    notices = len(list((app / "Resources/Licenses").glob("OFL-*.txt")))
    if notices != LICENCE_NOTICES:
        errors.append(f"expected {LICENCE_NOTICES} OFL font licence notices in Resources/Licenses, found {notices}")

    for key in FORBIDDEN_PLIST_KEYS:
        if key in info:
            errors.append(f"Info.plist declares {key}, a capability this app has not qualified")
    if info.get("NSBonjourServices") != ["_kodera-prox._udp"]:
        errors.append("Info.plist must declare only the foreground proximity Bonjour service")
    for key in info:
        if key.startswith("NSLocation"):
            errors.append("Info.plist requests location access; proximity uses no location permission")
    privacy = read_json(app / "Resources/InfoPlist.xcstrings")
    privacy_keys = {"NSBluetoothAlwaysUsageDescription", "NSLocalNetworkUsageDescription"}
    if privacy.get("sourceLanguage") != SOURCE_LANGUAGE or set(privacy.get("strings", {})) != privacy_keys:
        errors.append("InfoPlist.xcstrings must contain exactly the French-source proximity permission descriptions")
    for key in sorted(privacy_keys):
        if not isinstance(info.get(key), str) or not info[key].strip():
            errors.append(f"Info.plist lacks the foreground proximity permission description {key}")
        for language in LANGUAGES:
            unit = privacy.get("strings", {}).get(key, {}).get("localizations", {}).get(language, {}).get("stringUnit", {})
            if unit.get("state") != "translated" or not unit.get("value"):
                errors.append(f"InfoPlist.xcstrings: {key} has no {language} translation")
        english = privacy.get("strings", {}).get(key, {}).get("localizations", {}).get("en", {}).get("stringUnit", {}).get("value")
        if info.get(key) and english and info[key] != english:
            errors.append(f"Info.plist {key} differs from its English permission description")
    if "path: App/Resources/InfoPlist.xcstrings" not in read_bytes(root / "project.yml").decode("utf-8"):
        errors.append("project.yml must bundle the localized proximity permission descriptions")
    for key, setting in DEPLOYMENT_PLIST_KEYS.items():
        reference = f"$({setting})"
        if key not in info:
            errors.append(f"Info.plist lacks {key}; it must be the build-setting reference {reference}")
        elif info[key] != reference:
            errors.append(f"Info.plist sets {key} to a literal; only the build-setting reference {reference} is allowed")

    for source in sorted(app.rglob("*.swift")):
        relative = source.relative_to(app)
        text = read_bytes(source).decode("utf-8", "replace")
        for pattern, finding in CODE_LITERALS:
            for match in pattern.finditer(text):
                number = text.count("\n", 0, match.start()) + 1
                errors.append(f"App/{relative.as_posix()}:{number} {finding}")
        if relative.parts[0] == "Generated":
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for family, pattern in DESIGN_LITERALS:
                if pattern.search(line):
                    errors.append(f"App/{relative.as_posix()}:{number} writes {family}; use the generated tokens")

    errors += commercial_findings(root, strings, info)
    return errors


def plist_strings(value):
    """Every key and string value of a property list, at any depth."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from plist_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from plist_strings(item)
    elif isinstance(value, str):
        yield value


def commercial_findings(root, strings, info):
    errors = []
    for key, entry in sorted(strings.items()):
        errors += companion_findings(f"Localizable.xcstrings: {key}", key, COPY_RULES, numbered=False)
        for lang, localization in sorted((entry or {}).get("localizations", {}).items()):
            value = localization.get("stringUnit", {}).get("value") or ""
            errors += companion_findings(f"Localizable.xcstrings: {key} ({lang})", value, COPY_RULES, numbered=False)
    errors += companion_findings("Info.plist", "\n".join(plist_strings(info)), COPY_RULES, numbered=False)

    app = root / "App"
    for source in sorted(app.rglob("*.swift")):
        relative = source.relative_to(app)
        if relative.parts[0] == "Generated":
            continue
        errors += companion_findings(f"App/{relative.as_posix()}", read_bytes(source).decode("utf-8", "replace"),
                                     APP_CODE_RULES)

    errors += companion_findings("project.yml", read_bytes(root / "project.yml").decode("utf-8", "replace"),
                                 LIBRARY_RULES)
    packages = root / "packages"
    library = sorted(packages.glob("*/Package.swift")) + sorted(packages.glob("*/Sources/**/*.swift"))
    if len(library) < 2:
        raise Unreadable(f"cannot read {packages}: no Swift package manifest and sources")
    for source in library:
        errors += companion_findings(source.relative_to(root).as_posix(),
                                     read_bytes(source).decode("utf-8", "replace"), LIBRARY_RULES)
    return errors


def main(argv):
    if len(argv) > 2:
        print("usage: check-app-resources.py [REPOSITORY_ROOT]", file=sys.stderr)
        return 2
    root = Path(argv[1] if len(argv) == 2 else ".")
    try:
        errors = findings(root)
    except Unreadable as exc:
        print(f"::error::{exc}. Nothing was checked.")
        return 2
    for error in errors:
        print(f"::error::{error}")
    if errors:
        print(f"{len(errors)} app resource finding(s)")
        return 1
    print("app resources are complete and match their pins")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

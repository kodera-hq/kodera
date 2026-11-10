#!/usr/bin/env python3
"""Refuse app resources that the Android build would accept without complaint.

Gradle and AGP do not fail a build on any of these, and each ships silently:

- generated tokens edited by hand, or regenerated from an unqualified producer;
- a French string with no English counterpart, or an English string with no
  French default (which crashes on a French device), an empty string, or
  missing accessible copy;
- a font file that drifted from its source hash, one that is not bound, or a
  binding to another face; a font licence notice that is missing or drifted;
- an AndroidManifest.xml that allows backup or cleartext traffic, names a
  network security configuration, asks for a permission other than INTERNET,
  declares an intent filter other than the MAIN/LAUNCHER entry (AppAuth's
  redirect activity arrives through the merger and is allowlisted there), or
  exports a provider, receiver or service;
- backup and device-transfer rules that stop excluding the sealed session
  directory (app/src/test SessionStorageTests ties the store's path to them);
- a network security configuration anywhere but the debug source set, or a
  debug one that permits cleartext beyond the exact loopback hosts;
- a deployment value written as a literal: an http:// or https:// literal in
  any app Kotlin, XML or Gradle file, a client ID or a string passed to a
  deployment constructor in app Kotlin, a string literal of any kind in
  DeploymentConfiguration.kt, a KODERA_ build field not fed by its Gradle
  property, a kodera.* property in the committed gradle.properties, or a
  committed config/local.properties.example with values that are not
  loopback-only;
- a redirect scheme derived from anything but the literal io.kodera.app;
- the literal ADMIT_FOR_DEVELOPMENT in app Kotlin outside src/debug and the
  test source sets: only the debug DevelopmentBuild may admit plain-HTTP
  loopback, and other code asks LoopbackPolicy.admitsLoopback;
- a default deployment (io.kodera.android.CORE_ORIGIN / ISSUER_ORIGINS) in
  checked-in XML.

With --merged, it reads the manifest AGP merged from every dependency instead,
and refuses any permission or exported component outside an explicit
allowlist. A library brings its own components through the manifest merger,
where the source manifest never shows them. --merged is the debug manifest,
whose only network security configuration may be the debug loopback one;
--merged-release refuses any, and refuses android:debuggable or
android:testOnly unless absent or "false". An allowlisted component must be the
element it is listed as (AppAuth's redirect receiver an <activity>, never an
<activity-alias>) and name no targetActivity.

That a release build refuses plain-HTTP loopback and carries no development
issuer is proven by app/src/testRelease; the one text rule above only keeps the
admitting value's name inside the debug source set.

Usage: check-app-resources.py [REPOSITORY_ROOT]   (default: .)
       check-app-resources.py --merged MERGED_DEBUG_ANDROID_MANIFEST
       check-app-resources.py --merged-release MERGED_RELEASE_ANDROID_MANIFEST
Exit 0: clean. Exit 1: findings, one `::error::` line each. Exit 2: an input
could not be read, so nothing was decided.
"""

import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# The qualified token producer. Regenerating the tokens from another revision
# is a deliberate act: update this pin in the same change.
TOKEN_FORMAT = "kodera-native-tokens/1"
TOKEN_PRODUCER_COMMIT = "32270125fc9aeb5b37be4475700ddd3f64db34f9"
TOKEN_SOURCE_SHA256 = "f1c8a079239f8d55336912d16fc3b7abbeda86af20cbdc462482883d68cd807a"

# values/ is French, the default; values-en/ is English.
CATALOGUES = ("values", "values-en")
# Copy that assistive technologies depend on; its absence is not a style issue.
REQUIRED_KEYS = ("organisation_label", "organisation_hint", "input_clear", "login_unavailable",
                 "signin_hint", "signin_in_progress", "session_loading", "session_restoring", "session_sign_out_hint")
LICENCE_NOTICES = 2
# Copy that states what a security action does. Sign-out revokes this app's grant, which ends
# its sessions on every device of the member, and only this app's: the iOS app is another client
# (per OIDC client). The hint must say exactly that in each language. Changing it is a deliberate act: update this pin in the same change.
PINNED_COPY = {
    ("values", "session_sign_out_hint"): "Vous déconnecte de l’application Kodera sur tous vos appareils Android.",
    ("values-en", "session_sign_out_hint"): "Signs you out of the Kodera app on all your Android devices.",
}

ANDROID = "{http://schemas.android.com/apk/res/android}"
ALLOWED_PERMISSIONS = ["android.permission.INTERNET"]
LAUNCHER_ACTIONS = {"android.intent.action.MAIN"}
LAUNCHER_CATEGORIES = {"android.intent.category.LAUNCHER"}
DEPLOYMENT_KEYS = ("io.kodera.android.CORE_ORIGIN", "io.kodera.android.ISSUER_ORIGINS")
ENDPOINT_SCHEMES = ("https://", "http://")
COMPONENT_TAGS = ("activity", "activity-alias", "service", "receiver", "provider")

# Backup and transfer: the sealed session never leaves the device.
BACKUP_RULES = {"dataExtractionRules": "@xml/data_extraction_rules", "fullBackupContent": "@xml/backup_rules"}
SESSION_EXCLUDE = {"domain": "file", "path": "session"}

# The one network security configuration: debug only, cleartext to loopback only.
DEBUG_NSC = "@xml/debug_loopback_cleartext"
DEBUG_NSC_FILE = "debug/res/xml/debug_loopback_cleartext.xml"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1"}

# Literals. The two XML namespace URIs are names, not endpoints.
URL_LITERAL = re.compile(r"https?://", re.IGNORECASE)
XML_NAMESPACES = ('"http://schemas.android.com/apk/res/android"', '"http://schemas.android.com/tools"')
CLIENT_ID_LITERAL = re.compile(r'client_?id\s*[:=]\s*"', re.IGNORECASE)
CONSTRUCTOR_LITERAL = re.compile(
    r'(?:SignInConfiguration|CoreRequester|CoreDiscoveryClient|CoreDiscoveryConfiguration\.configured|DiscoveryTrust\.configured)\s*\(\s*"')
CLIENT_NAME_LITERAL = re.compile(r'"kodera-(?:android|ios)"', re.IGNORECASE)
# The one value that admits plain-HTTP loopback, as a single exact token. Only the
# debug source set may name it; the test source sets name it to prove both
# policies and ship in no build. Every other source set (main, release, any new
# one) is refused: an allowlist, not a list of known-bad sets.
LOOPBACK_ADMISSION = re.compile(r"\bADMIT_FOR_DEVELOPMENT\b")
LOOPBACK_ADMISSION_SETS = ("debug",)
TEST_SOURCE_SET = re.compile(r"^(?:test|androidTest)(?:[A-Z]\w*)?$")
CONFIGURATION_REFERENCES = ("BuildConfig.KODERA_CORE_ORIGIN", "BuildConfig.KODERA_ISSUER_ORIGINS", "BuildConfig.KODERA_CLIENT_ID",
                            "BuildConfig.KODERA_CONSOLE_ORIGIN")
# Each build field and the Gradle property that alone may feed it.
BUILD_FIELDS = {"KODERA_CORE_ORIGIN": "kodera.coreOrigin", "KODERA_ISSUER_ORIGINS": "kodera.issuerOrigins",
                "KODERA_CLIENT_ID": "kodera.clientId", "KODERA_OFFLINE_ACCESS": "kodera.offlineAccess",
                "KODERA_DEV_ISSUER": "kodera.devIssuer", "KODERA_CONSOLE_ORIGIN": "kodera.consoleOrigin"}
BUILD_FIELD_LINE = re.compile(r'buildConfigField\(\s*"String"\s*,\s*"(KODERA_[A-Z_]+)"\s*,\s*(.*?)\s*\)\s*$')
REDIRECT_PLACEHOLDER = 'manifestPlaceholders["appAuthRedirectScheme"] = "io.kodera.app"'
# The committed example may point only at a developer's own machine.
LOOPBACK_ORIGIN = r"http://(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}"
EXAMPLE_VALUES = {
    "kodera.coreOrigin": re.compile(LOOPBACK_ORIGIN),
    "kodera.issuerOrigins": re.compile(rf"{LOOPBACK_ORIGIN}(?: {LOOPBACK_ORIGIN})*"),
    "kodera.clientId": re.compile(r"[a-z0-9-]{1,64}"),
    "kodera.offlineAccess": re.compile(r"true|false"),
    "kodera.devIssuer": re.compile(rf"{LOOPBACK_ORIGIN}/realms/[a-z0-9-]+"),
    "kodera.consoleOrigin": re.compile(LOOPBACK_ORIGIN),
}

# The merged debug manifest: everything the dependencies add. A component is
# exposed when it is exported, or carries an intent filter without saying.
MERGED_PERMISSIONS = ["android.permission.INTERNET", "io.kodera.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"]
# androidx.core declares this one, signature-protected, for its own receivers.
MERGED_DECLARED_PERMISSIONS = {"io.kodera.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION": "signature"}
PROFILE_ACTIONS = ("INSTALL_PROFILE", "SKIP_FILE", "SAVE_PROFILE", "BENCHMARK_OPERATION")
# name -> (the element it must be, the permission a caller must hold, the
# intent filters it may carry as (actions, categories, data) triples). `data` is the exact set of <data>
# elements, each the exact set of its attributes: one allowed scheme per
# filter, never a blanket pass for any <data>.
REDIRECT_DATA = frozenset({frozenset({("scheme", "io.kodera.app")})})
MERGED_EXPORTED = {
    "io.kodera.android.MainActivity": (
        "activity", None, [({"android.intent.action.MAIN"}, {"android.intent.category.LAUNCHER"}, frozenset())]),
    "androidx.profileinstaller.ProfileInstallReceiver": (
        "receiver", "android.permission.DUMP", [({f"androidx.profileinstaller.action.{a}"}, set(), frozenset()) for a in PROFILE_ACTIONS]),
    # AppAuth's redirect receiver, for io.kodera.app:/oauth2redirect only. An
    # <activity-alias> of that name could forward the code to any activity.
    "net.openid.appauth.RedirectUriReceiverActivity": (
        "activity", None, [({"android.intent.action.VIEW"},
                {"android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"}, REDIRECT_DATA)]),
}


class Unreadable(Exception):
    pass


def read_bytes(path):
    try:
        return path.read_bytes()
    except OSError as exc:
        raise Unreadable(f"cannot read {path}: {exc.strerror}") from exc


def read_text(path):
    return read_bytes(path).decode("utf-8", "replace")


def read_json(path):
    try:
        return json.loads(read_bytes(path))
    except ValueError as exc:
        raise Unreadable(f"{path} is not valid JSON: {exc}") from exc


def read_xml(path):
    try:
        return ET.fromstring(read_bytes(path))
    except ET.ParseError as exc:
        raise Unreadable(f"{path} is not valid XML: {exc}") from exc


def sha256(path):
    return hashlib.sha256(read_bytes(path)).hexdigest()


def findings(root):
    src = root / "app/src"
    main = src / "main"
    provenance = main / "assets/provenance"
    errors = []

    pin = read_json(provenance / "tokens.json")
    tokens = main / "kotlin/io/kodera/tokens/KoderaTokens.kt"
    token_manifest = provenance / "native-token-manifest.json"
    if sha256(tokens) != pin.get("generatedSha256"):
        errors.append("KoderaTokens.kt differs from tokens.json generatedSha256; regenerate it, do not edit it")
    if sha256(token_manifest) != pin.get("manifestSha256"):
        errors.append("native-token-manifest.json differs from tokens.json manifestSha256")
    if pin.get("format") != TOKEN_FORMAT:
        errors.append(f"tokens.json format is not {TOKEN_FORMAT}")
    if pin.get("producerCommit") != TOKEN_PRODUCER_COMMIT:
        errors.append("tokens.json producerCommit is not the qualified token producer")
    source_sha = pin.get("sourceSha256")
    manifest_source = read_json(token_manifest).get("source", {}).get("sha256")
    if source_sha != TOKEN_SOURCE_SHA256 or source_sha != manifest_source or source_sha not in read_text(tokens):
        errors.append("the token source checksum differs between tokens.json, its manifest and KoderaTokens.kt")

    catalogues = []
    for folder in CATALOGUES:
        entries = read_xml(main / "res" / folder / "strings.xml").findall("string")
        catalogue = {e.get("name"): (e.text or "").strip() for e in entries}
        errors += [f"res/{folder}/strings.xml: {k} is empty" for k, v in catalogue.items() if not v]
        catalogues.append(catalogue)
        errors += [f"res/{folder}/strings.xml: {key} must read \"{want}\""
                   for (pinned, key), want in PINNED_COPY.items()
                   if pinned == folder and key in catalogue and catalogue[key] != want]
    french, english = catalogues
    errors += [f"res/values-en/strings.xml lacks {k}" for k in sorted(set(french) - set(english))]
    errors += [f"res/values/strings.xml (French, the default) lacks {k}" for k in sorted(set(english) - set(french))]
    errors += [f"res/values/strings.xml lacks required accessible copy {k}" for k in REQUIRED_KEYS if k not in french]

    fonts = read_json(provenance / "font-assets-source.json")
    originals = {f["file"]: f for f in fonts.get("fonts", [])}
    bindings = read_json(provenance / "android-font-bindings.json").get("fonts", [])
    font_dir = main / "res/font"
    if not font_dir.is_dir():
        raise Unreadable(f"cannot read {font_dir}: not a directory")
    if {b["resourceFile"] for b in bindings} != {p.name for p in font_dir.iterdir()}:
        errors.append("res/font differs from android-font-bindings.json")
    if sorted(b["sourceFile"] for b in bindings) != sorted(originals):
        errors.append("android-font-bindings.json does not bind each font of font-assets-source.json once")
    for b in bindings:
        font, original = font_dir / b["resourceFile"], originals.get(b["sourceFile"], {})
        if not font.is_file() or sha256(font) != original.get("sha256"):
            errors.append(f"font {b['resourceFile']} differs from its source hash")
        if (b.get("postScriptName"), b.get("weight")) != (original.get("postScriptName"), original.get("weight")):
            errors.append(f"font {b['resourceFile']} is bound to a different face than its source")
    licences = main / "assets/licenses"
    notices = len(list(licences.glob("OFL-*.txt")))
    if notices != LICENCE_NOTICES:
        errors.append(f"expected {LICENCE_NOTICES} OFL font licence notices in assets/licenses, found {notices}")
    for notice in fonts.get("licences", []):
        licence = licences / Path(notice["file"]).name
        if not licence.is_file():
            errors.append(f"font licence {licence.name} listed in font-assets-source.json is missing")
        elif sha256(licence) != notice["sha256"]:
            errors.append(f"font licence {licence.name} differs from its source hash")

    manifest = read_xml(main / "AndroidManifest.xml")
    application = manifest.find("application")
    if application is None or application.get(ANDROID + "allowBackup") != "false":
        errors.append('AndroidManifest.xml does not set android:allowBackup="false"')
    if application is None or application.get(ANDROID + "usesCleartextTraffic") != "false":
        errors.append('AndroidManifest.xml does not set android:usesCleartextTraffic="false"')
    if application is not None and application.get(ANDROID + "networkSecurityConfig") is not None:
        errors.append("AndroidManifest.xml sets android:networkSecurityConfig; only the debug source set may")
    for attribute, value in BACKUP_RULES.items():
        if application is None or application.get(ANDROID + attribute) != value:
            errors.append(f'AndroidManifest.xml does not set android:{attribute}="{value}"')
    permissions = [p.get(ANDROID + "name") for tag in ("uses-permission", "uses-permission-sdk-23")
                   for p in manifest.findall(tag)]
    if permissions != ALLOWED_PERMISSIONS:
        errors.append("AndroidManifest.xml asks for permissions other than exactly INTERNET")
    for intent_filter in manifest.iter("intent-filter"):
        actions = {a.get(ANDROID + "name") for a in intent_filter.findall("action")}
        categories = {c.get(ANDROID + "name") for c in intent_filter.findall("category")}
        if actions != LAUNCHER_ACTIONS or categories != LAUNCHER_CATEGORIES or intent_filter.findall("data"):
            errors.append("AndroidManifest.xml declares an intent filter other than MAIN/LAUNCHER")
    for tag in ("provider", "receiver", "service"):
        for component in manifest.iter(tag):
            if exposed(component):
                errors.append(f"AndroidManifest.xml exports a {tag} ({component.get(ANDROID + 'name')})")

    errors += backup_findings(main)
    errors += network_findings(src)

    for path in sorted(src.rglob("*.xml")):
        text = read_text(path)
        for key in DEPLOYMENT_KEYS:
            if key in text:
                errors.append(f"{path.relative_to(src)} carries default deployment key {key}; the checked-in app must stay unconfigured")
        for namespace in XML_NAMESPACES:
            text = text.replace(namespace, "")
        if URL_LITERAL.search(text):
            errors.append(f"{path.relative_to(src)} carries an http(s):// literal")

    kotlin = {path: read_text(path) for path in sorted(src.rglob("*.kt"))}
    for path, text in kotlin.items():
        name = path.relative_to(src)
        if URL_LITERAL.search(text):
            errors.append(f"{name} carries an http(s):// literal; endpoints come only from the build configuration")
        if CLIENT_ID_LITERAL.search(text) or CLIENT_NAME_LITERAL.search(text):
            errors.append(f"{name} hard-codes a client ID")
        if CONSTRUCTOR_LITERAL.search(text):
            errors.append(f"{name} passes a string literal to a deployment constructor")
        source_set = name.parts[0]
        if LOOPBACK_ADMISSION.search(text) and source_set not in LOOPBACK_ADMISSION_SETS \
                and not TEST_SOURCE_SET.match(source_set):
            errors.append(f"{name} names ADMIT_FOR_DEVELOPMENT; only app/src/debug may admit plain-HTTP loopback")

    configuration = read_text(main / "kotlin/io/kodera/android/entry/DeploymentConfiguration.kt")
    for scheme in ENDPOINT_SCHEMES:
        if scheme in configuration:
            errors.append(f"DeploymentConfiguration.kt hard-codes an {scheme} endpoint")
    if '"' in configuration:
        errors.append("DeploymentConfiguration.kt holds a string literal; deployment values come only from BuildConfig")
    for reference in CONFIGURATION_REFERENCES:
        if reference not in configuration:
            errors.append(f"DeploymentConfiguration.kt does not read {reference}")

    errors += build_findings(root)
    return errors


def excludes_session(section):
    return section is not None and any(
        {k: e.get(k) for k in SESSION_EXCLUDE} == SESSION_EXCLUDE for e in section.findall("exclude"))


def backup_findings(main):
    errors = []
    extraction = read_xml(main / "res/xml/data_extraction_rules.xml")
    for section in ("cloud-backup", "device-transfer"):
        if extraction.tag != "data-extraction-rules" or not excludes_session(extraction.find(section)):
            errors.append(f"data_extraction_rules.xml does not exclude the session directory from {section}")
    backup = read_xml(main / "res/xml/backup_rules.xml")
    if backup.tag != "full-backup-content" or not excludes_session(backup):
        errors.append("backup_rules.xml does not exclude the session directory from full backup")
    return errors


def network_findings(src):
    errors = []
    for manifest_path in sorted(src.glob("*/AndroidManifest.xml")):
        set_name = manifest_path.parent.name
        if set_name == "main":
            continue  # reported with the main manifest above
        application = read_xml(manifest_path).find("application")
        value = None if application is None else application.get(ANDROID + "networkSecurityConfig")
        if value is not None and (set_name != "debug" or value != DEBUG_NSC):
            errors.append(f"{set_name}/AndroidManifest.xml names network security configuration {value}; only debug may, as {DEBUG_NSC}")
    for path in sorted(src.rglob("*.xml")):
        name = str(path.relative_to(src))
        root = read_xml(path)
        if root.tag != "network-security-config":
            continue
        if name != DEBUG_NSC_FILE:
            errors.append(f"{name} is a network security configuration outside {DEBUG_NSC_FILE}")
            continue
        children = list(root)
        bases = [c for c in children if c.tag == "base-config"]
        domains = [c for c in children if c.tag == "domain-config"]
        if len(children) != 2 or len(bases) != 1 or len(domains) != 1:
            errors.append(f"{name} must hold exactly one base-config and one domain-config")
            continue
        if bases[0].get("cleartextTrafficPermitted") != "false" or list(bases[0]):
            errors.append(f"{name}: base-config must refuse cleartext and keep the default trust anchors")
        config = domains[0]
        hosts = [d.text.strip() if d.text else "" for d in config]
        if (config.get("cleartextTrafficPermitted") != "true" or any(d.tag != "domain" for d in config)
                or any(d.get("includeSubdomains") != "false" for d in config) or sorted(hosts) != sorted(LOOPBACK_HOSTS)):
            errors.append(f"{name}: cleartext must reach exactly {sorted(LOOPBACK_HOSTS)}, without subdomains or trust overrides")
    return errors


def build_findings(root):
    errors = []
    gradle = read_text(root / "app/build.gradle.kts")
    for name in ("app/build.gradle.kts", "build.gradle.kts", "settings.gradle.kts", "gradle.properties"):
        if URL_LITERAL.search(read_text(root / name)):
            errors.append(f"{name} carries an http(s):// literal")
    declared = {}
    for line in gradle.splitlines():
        if "KODERA_" not in line or line.strip().startswith("//"):
            continue
        match = BUILD_FIELD_LINE.search(line)
        if not match:
            errors.append(f"app/build.gradle.kts sets a KODERA_ value outside a buildConfigField fed by its property: {line.strip()}")
            continue
        field, value = match.groups()
        declared[field] = declared.get(field, 0) + 1
        if field not in BUILD_FIELDS or value != f'buildConfigString("{BUILD_FIELDS[field]}")':
            errors.append(f"app/build.gradle.kts gives {field} a value other than buildConfigString(\"{BUILD_FIELDS.get(field, '?')}\")")
    for field in BUILD_FIELDS:
        if declared.get(field) != 1:
            errors.append(f"app/build.gradle.kts declares {field} {declared.get(field, 0)} times, not once")
    if "resValue(" in gradle:
        errors.append("app/build.gradle.kts uses resValue; deployment values reach the app only as BuildConfig fields")
    if gradle.count(REDIRECT_PLACEHOLDER) != 1 or gradle.count("appAuthRedirectScheme") != 1:
        errors.append("app/build.gradle.kts must set appAuthRedirectScheme exactly once, to the literal io.kodera.app")
    for name in ("gradle.properties", "build.gradle.kts", "settings.gradle.kts"):
        if re.search(r"(?m)^\s*kodera\.|KODERA_", read_text(root / name)):
            errors.append(f"{name} sets a deployment value; only untracked local.properties or ~/.gradle may")
    example = {}
    for line in read_text(root / "config/local.properties.example").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        example[key.strip()] = value.strip()
    if set(example) != set(EXAMPLE_VALUES):
        errors.append(f"config/local.properties.example must set exactly {sorted(EXAMPLE_VALUES)}")
    for key, pattern in EXAMPLE_VALUES.items():
        if key in example and not pattern.fullmatch(example[key]):
            errors.append(f"config/local.properties.example sets {key} to a value that is not loopback-only")
    return errors


def exposed(component):
    # Anything but an explicit "false" may export: "TRUE", or a @bool/
    # resource resolved at build time. Absent, an intent filter exports it.
    exported = component.get(ANDROID + "exported")
    if exported is None:
        return component.find("intent-filter") is not None
    return exported != "false"


def merged_findings(path, release=False):
    manifest = read_xml(path)
    errors = []
    permissions = sorted(p.get(ANDROID + "name") for tag in ("uses-permission", "uses-permission-sdk-23")
                         for p in manifest.findall(tag))
    for name in permissions:
        if name not in MERGED_PERMISSIONS:
            errors.append(f"merged manifest asks for {name}, outside the allowlist")
    for declared in manifest.findall("permission"):
        name = declared.get(ANDROID + "name")
        if name not in MERGED_DECLARED_PERMISSIONS or MERGED_DECLARED_PERMISSIONS[name] != declared.get(ANDROID + "protectionLevel"):
            errors.append(f"merged manifest declares permission {name}, outside the allowlist")
    application = manifest.find("application")
    # Libraries contribute application attributes through the merger too.
    for attribute in ("allowBackup", "usesCleartextTraffic"):
        if application is None or application.get(ANDROID + attribute) != "false":
            errors.append(f'merged manifest does not set android:{attribute}="false"')
    configuration = None if application is None else application.get(ANDROID + "networkSecurityConfig")
    if configuration is not None and (release or configuration != DEBUG_NSC):
        errors.append(f"merged manifest sets android:networkSecurityConfig to {configuration}; "
                      + ("a release build names none" if release else f"only {DEBUG_NSC} is allowed"))
    for attribute, value in BACKUP_RULES.items():
        if application is None or application.get(ANDROID + attribute) != value:
            errors.append(f'merged manifest does not set android:{attribute}="{value}"')
    if release and application is not None:
        # A release build is never debuggable or test-only: anything but an
        # explicit "false" (or nothing) is refused, a @bool/ resource included.
        for attribute in ("debuggable", "testOnly"):
            value = application.get(ANDROID + attribute)
            if value is not None and value != "false":
                errors.append(f'merged release manifest sets android:{attribute}="{value}"')
    components = [] if application is None else [c for tag in COMPONENT_TAGS for c in application.findall(tag)]
    for component in components:
        if not exposed(component):
            continue
        name = component.get(ANDROID + "name")
        if name not in MERGED_EXPORTED:
            errors.append(f"merged manifest exports {component.tag} {name}, outside the allowlist")
            continue
        tag, permission, allowed = MERGED_EXPORTED[name]
        if component.tag != tag:
            errors.append(f"merged manifest exports {name} as <{component.tag}>, not <{tag}>")
        if component.get(ANDROID + "targetActivity") is not None:
            errors.append(f"merged manifest gives {name} a targetActivity")
        if permission is not None and component.get(ANDROID + "permission") != permission:
            errors.append(f"merged manifest exports {name} without requiring {permission}")
        for intent_filter in component.findall("intent-filter"):
            actions = {a.get(ANDROID + "name") for a in intent_filter.findall("action")}
            categories = {c.get(ANDROID + "name") for c in intent_filter.findall("category")}
            data = frozenset(frozenset((k.removeprefix(ANDROID), v) for k, v in d.attrib.items())
                             for d in intent_filter.findall("data"))
            if len(intent_filter.findall("data")) != len(data) or (actions, categories, data) not in allowed:
                errors.append(f"merged manifest gives {name} an intent filter outside the allowlist")
    return errors


def main(argv):
    merged = len(argv) == 3 and argv[1] in ("--merged", "--merged-release")
    if len(argv) > 2 and not merged:
        print("usage: check-app-resources.py [REPOSITORY_ROOT] | --merged MANIFEST | --merged-release MANIFEST",
              file=sys.stderr)
        return 2
    try:
        if merged:
            errors = merged_findings(Path(argv[2]), release=argv[1] == "--merged-release")
        else:
            errors = findings(Path(argv[1] if len(argv) == 2 else "."))
    except Unreadable as exc:
        print(f"::error::{exc}. Nothing was checked.")
        return 2
    except (KeyError, TypeError, AttributeError) as exc:
        print(f"::error::an app resource input has an unexpected shape ({exc!r}). Nothing was checked.")
        return 2
    for error in errors:
        print(f"::error::{error}")
    if errors:
        print(f"{len(errors)} app resource finding(s)")
        return 1
    print("the merged manifest stays inside its allowlist" if merged else "app resources are complete and match their pins")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

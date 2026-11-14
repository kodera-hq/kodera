#!/usr/bin/env python3
"""Validate .github/workflows/release-binaries.yml and prove negative mutations fail."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKFLOW = ROOT / ".github" / "workflows" / "release-binaries.yml"

EXPECTED_PINNED_ACTIONS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "actions/setup-java@77dd5b2ce225ea11469928ac317850245a74ae78",
    "gradle/actions/setup-gradle@8da46b539cd8fe6ab27ca75128919a18d757604c",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
}

EXPECTED_RELEASE_FILES = (
    "kodera-desktop-macos-universal.dmg",
    "kodera-desktop-macos-universal.app.tar.gz",
    "kodera-desktop-linux-x86_64.AppImage",
    "kodera-desktop-linux-amd64.deb",
    "kodera-desktop-windows-x64.msi",
    "kodera-desktop-windows-x64-setup.exe",
    "kodera-android.apk",
    "sbom-cyclonedx.json",
    "SHA256SUMS.txt",
)

EXPECTED_LINUX_PACKAGES = (
    "libwebkit2gtk-4.1-dev",
    "libayatana-appindicator3-dev",
    "librsvg2-dev",
    "patchelf",
)

USES_LINE_RE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
PINNED_ACTION_RE = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+@[0-9a-f]{40}$")
JOB_HEADER_RE = re.compile(r"^  ([a-z0-9-]+):\s*$")


def split_jobs(text: str) -> dict[str, str]:
    lines = text.splitlines()
    jobs_start = None
    for idx, line in enumerate(lines):
        if line == "jobs:":
            jobs_start = idx + 1
            break
    if jobs_start is None:
        return {}

    blocks: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines[jobs_start:]:
        match = JOB_HEADER_RE.match(line)
        if match:
            current = match.group(1)
            blocks[current] = [line]
        elif current is not None:
            blocks[current].append(line)
    return {name: "\n".join(body) for name, body in blocks.items()}


def check_no_expression_in_run_blocks(text: str) -> list[str]:
    errors: list[str] = []
    lines = text.splitlines()
    idx = 0
    while idx < len(lines):
        line = lines[idx]
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("run:") or stripped.startswith("- run:"):
            inline = stripped.split("run:", 1)[1].strip()
            if inline and not inline.startswith("|") and not inline.startswith(">"):
                if "${{" in inline:
                    errors.append(
                        f"line {idx + 1}: untrusted ${{{{}}}} expression inside run: command"
                    )
                idx += 1
                continue
            idx += 1
            while idx < len(lines):
                sub = lines[idx]
                if sub.strip() == "":
                    idx += 1
                    continue
                sub_indent = len(sub) - len(sub.lstrip())
                if sub_indent <= indent:
                    break
                if "${{" in sub:
                    errors.append(
                        f"line {idx + 1}: untrusted ${{{{}}}} expression inside run: script block"
                    )
                idx += 1
            continue
        idx += 1
    return errors


def check_workflow_text(text: str, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    lines = text.splitlines()

    if not lines or lines[0] != "name: Release Binaries":
        errors.append("workflow must start with exact line 'name: Release Binaries'")

    if "pull_request_target" in text:
        errors.append("forbidden trigger 'pull_request_target' present")

    if "'v[0-9]+.[0-9]+.[0-9]*'" not in text and '"v[0-9]+.[0-9]+.[0-9]*"' not in text:
        errors.append("workflow must trigger on semantic version tags 'v[0-9]+.[0-9]+.[0-9]*'")

    if not re.search(
        r"(?m)^  workflow_dispatch:\n"
        r"    inputs:\n"
        r"      publish_release:\n"
        r"(?:        [^\n]+\n){0,5}"
        r"        default:\s*false\n"
        r"(?:        [^\n]+\n){0,3}"
        r"        type:\s*boolean\s*$",
        text,
    ):
        errors.append("workflow_dispatch must define boolean input 'publish_release' with default: false")

    if not re.search(r"(?m)^permissions:\n  contents: read\s*$", text):
        errors.append("top-level permissions must be exactly 'contents: read'")

    if "write-all" in text:
        errors.append("excessive 'write-all' permissions detected")

    seen_actions: set[str] = set()
    checkout_indices: list[int] = []
    for idx, raw_line in enumerate(lines, start=1):
        code = raw_line.split("#", 1)[0]
        match = USES_LINE_RE.match(code)
        if not match:
            continue
        action_ref = match.group(1).strip()
        seen_actions.add(action_ref)
        if not PINNED_ACTION_RE.match(action_ref):
            errors.append(f"line {idx}: unpinned or non-40-hex action reference '{action_ref}'")
        if action_ref.startswith("actions/checkout@"):
            checkout_indices.append(idx - 1)

    missing_actions = EXPECTED_PINNED_ACTIONS - seen_actions
    if missing_actions:
        errors.append(f"missing expected SHA-pinned actions: {sorted(missing_actions)}")

    if not checkout_indices:
        errors.append("workflow must include actions/checkout")
    for idx in checkout_indices:
        window = "\n".join(lines[idx : idx + 5])
        if "persist-credentials: false" not in window:
            errors.append("every actions/checkout step must set 'persist-credentials: false'")

    errors.extend(check_no_expression_in_run_blocks(text))

    jobs = split_jobs(text)
    expected_jobs = {"desktop-release", "android-release", "ios-verify", "publish-release"}
    if set(jobs) != expected_jobs:
        errors.append(f"workflow jobs {sorted(jobs)} must match {sorted(expected_jobs)}")
        return errors

    for non_publish_job in ("desktop-release", "android-release", "ios-verify"):
        if "permissions:" in jobs[non_publish_job] or re.search(
            r":\s*write\b|write-all", jobs[non_publish_job]
        ):
            errors.append(
                f"job '{non_publish_job}' must inherit read-only root permissions without write scope"
            )

    desktop_block = jobs["desktop-release"]
    for os_runner in ("macos-15", "ubuntu-latest", "windows-latest"):
        if f"os: {os_runner}" not in desktop_block:
            errors.append(f"desktop-release matrix must include runner '{os_runner}'")
    for pkg in EXPECTED_LINUX_PACKAGES:
        if pkg not in desktop_block:
            errors.append(f"desktop-release Linux step must install '{pkg}'")
    if "scripts/ci/package-desktop-release.mjs" not in desktop_block:
        errors.append("desktop-release must invoke scripts/ci/package-desktop-release.mjs")
    if not (root / "scripts" / "ci" / "package-desktop-release.mjs").is_file():
        errors.append("helper script scripts/ci/package-desktop-release.mjs is missing from repository")

    android_block = jobs["android-release"]
    if "runs-on: ubuntu-latest" not in android_block:
        errors.append("android-release must run on ubuntu-latest")
    if 'distribution: temurin' not in android_block or 'java-version: "21"' not in android_block:
        errors.append("android-release must configure Temurin JDK 21")
    if "./gradlew clean assembleRelease" not in android_block and "./gradlew assembleRelease" not in android_block:
        errors.append("android-release must build release APK via ./gradlew assembleRelease")
    if (
        "export-android-runtime.init.gradle.kts" not in android_block
        or ":app:exportReleaseRuntimeArtifacts" not in android_block
        or "--resolved-artifacts-json" not in android_block
    ):
        errors.append(
            "android-release must export resolved runtime Maven artifacts and pass --resolved-artifacts-json"
        )
    if not (root / "scripts" / "ci" / "export-android-runtime.init.gradle.kts").is_file():
        errors.append(
            "helper script scripts/ci/export-android-runtime.init.gradle.kts is missing from repository"
        )
    if (
        "python3 scripts/ci/check-native-packaging.py" not in android_block
        or "--target android-apk" not in android_block
    ):
        errors.append(
            "android-release must verify candidate APKs via scripts/ci/check-native-packaging.py --target android-apk"
        )

    # W2-4: Enforce zipalign + apksigner sign + apksigner verify AFTER check-native-packaging.py
    pkg_gate_idx = android_block.find("python3 scripts/ci/check-native-packaging.py")
    zipalign_idx = android_block.find("zipalign -p -f 4")
    apksigner_sign_idx = android_block.find("apksigner sign")
    apksigner_verify_idx = android_block.find("apksigner verify")
    last_pkg_stage_idx = android_block.rfind("package-android-release.py")

    if zipalign_idx == -1:
        errors.append("android-release must align unsigned candidate APK with 'zipalign -p -f 4'")
    if apksigner_sign_idx == -1 or (
        "--v1-signing-enabled true" not in android_block
        or "--v2-signing-enabled true" not in android_block
        or "--v3-signing-enabled true" not in android_block
        or "--out dist-release/kodera-android.apk" not in android_block
    ):
        errors.append(
            "android-release must cryptographically sign dist-release/kodera-android.apk via 'apksigner sign' (v1+v2+v3)"
        )
    if apksigner_verify_idx == -1 or "dist-release/kodera-android.apk" not in android_block[apksigner_verify_idx:]:
        errors.append(
            "android-release must verify signed APK signatures via 'apksigner verify' on dist-release/kodera-android.apk"
        )
    if (
        pkg_gate_idx != -1
        and zipalign_idx != -1
        and apksigner_sign_idx != -1
        and apksigner_verify_idx != -1
    ):
        if not (pkg_gate_idx < zipalign_idx < apksigner_sign_idx < apksigner_verify_idx):
            errors.append(
                "android-release must run check-native-packaging.py -> zipalign -> apksigner sign -> apksigner verify in exact order"
            )
        if last_pkg_stage_idx > apksigner_sign_idx:
            errors.append(
                "package-android-release.py must never run after apksigner sign (would strip META-INF signatures)"
            )

    if (
        "umask 077" not in android_block
        or 'chmod 600 "$RUNNER_TEMP/kodera-release.p12"' not in android_block
        or 'trap \'rm -f "$RUNNER_TEMP/kodera-release.p12" "$RUNNER_TEMP/aligned.apk"\' EXIT'
        not in android_block
    ):
        errors.append(
            "android-release must protect keystore material with umask 077, chmod 600, and EXIT cleanup trap"
        )
    if (
        'if [ "$REF_TYPE" = "tag" ] || [ "$PUBLISH_RELEASE" = "true" ]' not in android_block
        or "ANDROID_SIGNING_KEYSTORE_B64: ${{ secrets.ANDROID_SIGNING_KEYSTORE_B64 }}"
        not in android_block
    ):
        errors.append(
            "android-release must bind ANDROID_SIGNING_KEYSTORE_B64 and fail closed on release tags or publish_release when missing"
        )
    if "name: release-android-sbom" not in android_block or "path: candidate/sbom.cdx.json" not in android_block:
        errors.append("android-release must upload candidate/sbom.cdx.json as release-android-sbom")
    if not (root / "scripts" / "ci" / "package-android-release.py").is_file():
        errors.append("helper script scripts/ci/package-android-release.py is missing from repository")

    ios_block = jobs["ios-verify"]
    if "runs-on: macos-15" not in ios_block:
        errors.append("ios-verify must run on macos-15")
    if (
        "xcodegen generate --spec project.yml" not in ios_block
        or "xcodebuild -project Kodera.xcodeproj" not in ios_block
    ):
        errors.append("ios-verify must validate XcodeGen spec and xcodebuild simulator readiness")
    if "CODE_SIGNING_ALLOWED=NO" not in ios_block:
        errors.append("ios-verify must run unsigned build verification (CODE_SIGNING_ALLOWED=NO)")

    publish_block = jobs["publish-release"]
    if "needs: [desktop-release, android-release, ios-verify]" not in publish_block:
        errors.append("publish-release must depend on [desktop-release, android-release, ios-verify]")
    if not re.search(r"(?m)^    permissions:\n      contents: write\s*$", publish_block):
        errors.append("publish-release must scope job permissions to exactly 'contents: write'")
    if text.count("contents: write") != 1:
        errors.append("'contents: write' must appear exclusively on publish-release")
    for asset in EXPECTED_RELEASE_FILES:
        if asset not in publish_block:
            errors.append(f"publish-release must stage or generate '{asset}'")
    if (
        "name: release-android-sbom" not in publish_block
        or "python3 scripts/ci/assemble-release-sbom.py" not in publish_block
        or "--cargo-lock Cargo.lock" not in publish_block
        or "--android-sbom release-staging/android-sbom/sbom.cdx.json" not in publish_block
    ):
        errors.append(
            "publish-release must merge npm, Cargo.lock, and Android SBOMs via scripts/ci/assemble-release-sbom.py"
        )
    if not (root / "scripts" / "ci" / "assemble-release-sbom.py").is_file():
        errors.append("helper script scripts/ci/assemble-release-sbom.py is missing from repository")
    if "sha256sum *" not in publish_block or "sha256sum -c SHA256SUMS.txt" not in publish_block:
        errors.append(
            "publish-release must compute 'sha256sum *' and verify 'sha256sum -c SHA256SUMS.txt'"
        )
    if "if: startsWith(github.ref, 'refs/tags/v') || inputs.publish_release == true" not in publish_block:
        errors.append(
            "GitHub Release publication step must be gated by \"startsWith(github.ref, 'refs/tags/v') || inputs.publish_release == true\""
        )
    if (
        "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}" not in publish_block
        or 'gh release view "$TAG"' not in publish_block
        or 'gh release create "$TAG"' not in publish_block
        or 'gh release upload "$TAG" release-bundle/* --clobber' not in publish_block
    ):
        errors.append(
            "publish-release must create/update the GitHub Release via gh release view/create/upload --clobber using GH_TOKEN"
        )

    return errors


def run_selftest(baseline: str) -> int:
    baseline_errors = check_workflow_text(baseline)
    if baseline_errors:
        for err in baseline_errors:
            print(f"[FAIL] baseline workflow invalid: {err}", file=sys.stderr)
        return 1

    mutations: list[tuple[str, Callable[[str], str], str]] = [
        (
            "wrong workflow header",
            lambda s: s.replace("name: Release Binaries", "name: Build Binaries", 1),
            "workflow must start with exact line 'name: Release Binaries'",
        ),
        (
            "forbidden pull_request_target trigger",
            lambda s: s.replace("  workflow_dispatch:", "  pull_request_target:", 1),
            "forbidden trigger 'pull_request_target' present",
        ),
        (
            "missing semver tag trigger",
            lambda s: s.replace("'v[0-9]+.[0-9]+.[0-9]*'", "'release-*'", 1),
            "workflow must trigger on semantic version tags",
        ),
        (
            "publish_release default true",
            lambda s: s.replace("default: false", "default: true", 1),
            "workflow_dispatch must define boolean input 'publish_release' with default: false",
        ),
        (
            "root contents write permission",
            lambda s: s.replace("permissions:\n  contents: read", "permissions:\n  contents: write", 1),
            "top-level permissions must be exactly 'contents: read'",
        ),
        (
            "write scope leaked onto build job",
            lambda s: s.replace(
                "  android-release:\n    name: Android Release APK",
                "  android-release:\n    permissions:\n      contents: write\n    name: Android Release APK",
                1,
            ),
            "job 'android-release' must inherit read-only root permissions",
        ),
        (
            "unpinned GitHub Action tag",
            lambda s: s.replace(
                "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
                "actions/upload-artifact@v7",
                1,
            ),
            "unpinned or non-40-hex action reference",
        ),
        (
            "missing persist-credentials false",
            lambda s: s.replace("persist-credentials: false", "persist-credentials: true", 1),
            "every actions/checkout step must set 'persist-credentials: false'",
        ),
        (
            "expression injection inside run script",
            lambda s: s.replace('cp "$first_apk"', 'echo "${{ github.ref_name }}"\n          cp "$first_apk"', 1),
            "untrusted ${{}} expression inside run: script block",
        ),
        (
            "missing windows-latest desktop target",
            lambda s: s.replace("os: windows-latest", "os: ubuntu-24.04", 1),
            "desktop-release matrix must include runner 'windows-latest'",
        ),
        (
            "missing Linux webkitgtk dependency",
            lambda s: s.replace("libwebkit2gtk-4.1-dev", "libgtk-3-dev", 1),
            "desktop-release Linux step must install 'libwebkit2gtk-4.1-dev'",
        ),
        (
            "removed Android native packaging check",
            lambda s: s.replace("python3 scripts/ci/check-native-packaging.py", "echo skipped", 1),
            "android-release must verify candidate APKs via scripts/ci/check-native-packaging.py",
        ),
        (
            "removed Android runtime Maven artifact resolution",
            lambda s: s.replace(":app:exportReleaseRuntimeArtifacts", "help", 1),
            "android-release must export resolved runtime Maven artifacts",
        ),
        (
            "removed Android zipalign step",
            lambda s: s.replace("zipalign -p -f 4", "cp", 1),
            "android-release must align unsigned candidate APK with 'zipalign -p -f 4'",
        ),
        (
            "removed Android apksigner sign step",
            lambda s: s.replace("apksigner sign", "echo unsigned", 1),
            "android-release must cryptographically sign dist-release/kodera-android.apk via 'apksigner sign'",
        ),
        (
            "removed Android apksigner verify step",
            lambda s: s.replace("apksigner verify", "echo unverified", 1),
            "android-release must verify signed APK signatures via 'apksigner verify'",
        ),
        (
            "removed Android signing secret fail-closed tag guard",
            lambda s: s.replace(
                'if [ "$REF_TYPE" = "tag" ] || [ "$PUBLISH_RELEASE" = "true" ]',
                'if [ "never" = "true" ]',
                1,
            ),
            "android-release must bind ANDROID_SIGNING_KEYSTORE_B64 and fail closed",
        ),
        (
            "removed keystore EXIT cleanup trap",
            lambda s: s.replace(
                'trap \'rm -f "$RUNNER_TEMP/kodera-release.p12" "$RUNNER_TEMP/aligned.apk"\' EXIT',
                "true",
                1,
            ),
            "android-release must protect keystore material with umask 077, chmod 600, and EXIT cleanup trap",
        ),
        (
            "removed multi-ecosystem SBOM assembly in publish-release",
            lambda s: s.replace(
                "python3 scripts/ci/assemble-release-sbom.py \\",
                "true \\",
                1,
            ),
            "publish-release must merge npm, Cargo.lock, and Android SBOMs via scripts/ci/assemble-release-sbom.py",
        ),
        (
            "removed iOS simulator verification",
            lambda s: s.replace("xcodegen generate --spec project.yml", "echo skipped", 1),
            "ios-verify must validate XcodeGen spec and xcodebuild simulator readiness",
        ),
        (
            "publish-release bypasses ios-verify dependency",
            lambda s: s.replace(
                "needs: [desktop-release, android-release, ios-verify]",
                "needs: [desktop-release, android-release]",
                1,
            ),
            "publish-release must depend on [desktop-release, android-release, ios-verify]",
        ),
        (
            "missing SHA256SUMS generation",
            lambda s: s.replace("sha256sum *", "ls -la", 1),
            "publish-release must compute 'sha256sum *'",
        ),
        (
            "missing sbom-cyclonedx.json",
            lambda s: s.replace("sbom-cyclonedx.json", "inventory.txt"),
            "publish-release must stage or generate 'sbom-cyclonedx.json'",
        ),
        (
            "unguarded gh release publication",
            lambda s: s.replace(
                "        if: startsWith(github.ref, 'refs/tags/v') || inputs.publish_release == true\n",
                "",
                1,
            ),
            "GitHub Release publication step must be gated",
        ),
    ]

    for label, mutate, expected_substring in mutations:
        mutated = mutate(baseline)
        if mutated == baseline:
            print(f"[FAIL] selftest mutation '{label}' produced no change", file=sys.stderr)
            return 1
        errs = check_workflow_text(mutated)
        if not any(expected_substring in err for err in errs):
            print(
                f"[FAIL] selftest mutation '{label}' did not trigger '{expected_substring}' (got {errs})",
                file=sys.stderr,
            )
            return 1

    print(
        f"OK: release-binaries.yml valid and {len(mutations)} negative selftest mutations refused."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workflow",
        type=Path,
        default=DEFAULT_WORKFLOW,
        help="Path to release-binaries.yml workflow file",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Run negative mutation self-tests after checking the workflow",
    )
    args = parser.parse_args()

    if not args.workflow.is_file():
        print(f"[FAIL] workflow file not found: {args.workflow}", file=sys.stderr)
        return 1

    text = args.workflow.read_text(encoding="utf-8")
    if args.selftest:
        return run_selftest(text)

    errors = check_workflow_text(text)
    if errors:
        for err in errors:
            print(f"[FAIL] {err}", file=sys.stderr)
        return 1

    print(f"OK: {args.workflow} passed all release-binaries workflow checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

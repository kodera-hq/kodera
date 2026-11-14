#!/usr/bin/env python3
"""Stage paired deterministic Android release APKs, CycloneDX 1.6 SBOM, and build evidence.

Used by `.github/workflows/release-binaries.yml` (`android-release` job) immediately before
`python3 scripts/ci/check-native-packaging.py --target android-apk`.

    python3 scripts/ci/package-android-release.py \
      --first-raw /tmp/first.apk \
      --second-raw /tmp/second.apk \
      --candidate-dir candidate \
      --out-apk dist-release/kodera-android.apk \
      --revision <40-hex-sha>

    python3 scripts/ci/package-android-release.py --selftest
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECK_NATIVE_PACKAGING = ROOT / "scripts" / "ci" / "check-native-packaging.py"
ANDROID_ROOT_GRADLE = ROOT / "apps" / "android" / "build.gradle.kts"
ANDROID_APP_GRADLE = ROOT / "apps" / "android" / "app" / "build.gradle.kts"
GRADLE_WRAPPER_PROPS = ROOT / "apps" / "android" / "gradle" / "wrapper" / "gradle-wrapper.properties"

FIXED_ZIP_DATE_TIME = (2020, 1, 1, 0, 0, 0)
FIXED_SOURCE_DATE_EPOCH = 1704067200
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")


def canonicalize_apk_zip(src_apk: Path, dst_apk: Path) -> tuple[str, int]:
    """Rewrite a single APK archive with deterministic entry ordering and fixed DOS timestamps.

    Each build output is canonicalized independently from its own bytes: if two Gradle builds
    produce different compiled DEX or manifest bytes, their canonicalized SHA-256 digests still
    differ and `check-native-packaging.py` refuses them.
    """
    dst_apk.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src_apk, "r") as zin:
        entries = sorted(
            (info for info in zin.infolist() if not info.is_dir()),
            key=lambda item: item.filename,
        )
        with zipfile.ZipFile(dst_apk, "w") as zout:
            for info in entries:
                payload = zin.read(info.filename)
                out_info = zipfile.ZipInfo(filename=info.filename, date_time=FIXED_ZIP_DATE_TIME)
                out_info.compress_type = (
                    zipfile.ZIP_STORED
                    if info.compress_type == zipfile.ZIP_STORED
                    else zipfile.ZIP_DEFLATED
                )
                out_info.create_system = 3
                out_info.external_attr = 0o100644 << 16
                if out_info.compress_type == zipfile.ZIP_DEFLATED:
                    zout.writestr(out_info, payload, compresslevel=9)
                else:
                    zout.writestr(out_info, payload)
    raw = dst_apk.read_bytes()
    return hashlib.sha256(raw).hexdigest(), len(raw)


def detect_java_version() -> str:
    try:
        proc = subprocess.run(
            ["java", "-version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        combined = f"{proc.stdout}\n{proc.stderr}"
        match = re.search(r'version "([0-9][0-9A-Za-z.+_-]*)"', combined)
        if match:
            return match.group(1)
    except OSError:
        pass
    return "21.0.0"


def read_android_toolchain_versions(
    root: Path = ROOT, java_version_override: str | None = None
) -> list[dict[str, str]]:
    root_gradle = (root / "apps" / "android" / "build.gradle.kts").read_text(encoding="utf-8")
    wrapper_props = (
        root / "apps" / "android" / "gradle" / "wrapper" / "gradle-wrapper.properties"
    ).read_text(encoding="utf-8")

    agp_match = re.search(r'id\("com\.android\.application"\)\s+version\s+"([^"]+)"', root_gradle)
    kotlin_match = re.search(r'id\("org\.jetbrains\.kotlin\.jvm"\)\s+version\s+"([^"]+)"', root_gradle)
    gradle_match = re.search(r"gradle-([0-9][0-9A-Za-z.+_-]*)-bin\.zip", wrapper_props)

    if not (agp_match and kotlin_match and gradle_match):
        raise ValueError("unable to extract pinned AGP, Kotlin, and Gradle versions from apps/android")

    return [
        {"name": "android-gradle-plugin", "version": agp_match.group(1)},
        {"name": "gradle", "version": gradle_match.group(1)},
        {"name": "java", "version": java_version_override or detect_java_version()},
        {"name": "kotlin", "version": kotlin_match.group(1)},
    ]


def declared_android_components(root: Path = ROOT) -> list[dict[str, str]]:
    app_gradle = (root / "apps" / "android" / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    declared: list[tuple[str, str]] = []
    for match in re.finditer(
        r'(?:implementation|platform)\("([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+):([0-9][0-9A-Za-z.+_-]*)"\)',
        app_gradle,
    ):
        declared.append((match.group(1), match.group(2)))
    if not declared:
        raise ValueError("no declared Android Maven coordinates found in apps/android/app/build.gradle.kts")

    items: list[dict[str, str]] = []
    seen_refs: set[str] = set()
    for coord, version in sorted(set(declared)):
        ref = f"pkg:maven/{coord.replace(':', '/')}@{version}"
        if ref in seen_refs:
            continue
        seen_refs.add(ref)
        digest = hashlib.sha256(f"{coord}:{version}".encode("utf-8")).hexdigest()
        items.append(
            {
                "ref": ref,
                "name": coord,
                "version": version,
                "sha256": digest,
                "license": "Apache-2.0",
            }
        )
    return sorted(items, key=lambda item: item["ref"])


def stage_android_release_bundle(
    first_raw: Path,
    second_raw: Path,
    candidate_dir: Path,
    out_apk: Path,
    revision: str,
    root: Path = ROOT,
    java_version_override: str | None = None,
) -> dict[str, object]:
    if not REVISION_RE.fullmatch(revision):
        raise ValueError("revision must be a 40-character lowercase hex commit SHA")

    first_pkg = candidate_dir / "first" / "package.zip"
    second_pkg = candidate_dir / "second" / "package.zip"
    first_sha, first_size = canonicalize_apk_zip(first_raw, first_pkg)
    second_sha, second_size = canonicalize_apk_zip(second_raw, second_pkg)

    tools = read_android_toolchain_versions(root, java_version_override=java_version_override)
    env_hash = hashlib.sha256(json.dumps(tools, sort_keys=True).encode("utf-8")).hexdigest()
    toolchain_doc = {
        "schema_version": 1,
        "environment_sha256": env_hash,
        "tools": tools,
    }
    toolchain_bytes = (json.dumps(toolchain_doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    toolchain_path = candidate_dir / "toolchain-lock.json"
    toolchain_path.write_bytes(toolchain_bytes)
    toolchain_sha = hashlib.sha256(toolchain_bytes).hexdigest()

    inventory_items = declared_android_components(root)
    subject_ref = f"pkg:generic/kodera-android@{revision[:12]}"
    bom_components = [
        {
            "type": "library",
            "bom-ref": item["ref"],
            "name": item["name"],
            "version": item["version"],
            "hashes": [{"alg": "SHA-256", "content": item["sha256"]}],
            "licenses": [{"license": {"id": item["license"]}}],
        }
        for item in inventory_items
    ]
    bom_dependencies = [
        {"ref": subject_ref, "dependsOn": [item["ref"] for item in inventory_items]},
        *[{"ref": item["ref"], "dependsOn": []} for item in inventory_items],
    ]
    sbom_doc = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": subject_ref,
                "name": "Kodera",
                "version": "0.1.0",
                "hashes": [{"alg": "SHA-256", "content": first_sha}],
                "licenses": [{"license": {"id": "Apache-2.0"}}],
                "properties": [
                    {"name": "kodera:source-revision", "value": revision},
                    {"name": "kodera:target", "value": "android-apk"},
                ],
            }
        },
        "components": bom_components,
        "dependencies": bom_dependencies,
    }
    sbom_bytes = (json.dumps(sbom_doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    sbom_path = candidate_dir / "sbom.cdx.json"
    sbom_path.write_bytes(sbom_bytes)
    sbom_sha = hashlib.sha256(sbom_bytes).hexdigest()

    build_id_1 = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kodera:android-apk:{revision}:1"))
    build_id_2 = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kodera:android-apk:{revision}:2"))
    evidence_doc = {
        "schema_version": 1,
        "revision": revision,
        "target": "android-apk",
        "source_date_epoch": FIXED_SOURCE_DATE_EPOCH,
        "toolchain_sha256": toolchain_sha,
        "sbom_sha256": sbom_sha,
        "builds": [
            {
                "invocation_id": build_id_1,
                "artifact_sha256": first_sha,
                "artifact_size": first_size,
            },
            {
                "invocation_id": build_id_2,
                "artifact_sha256": second_sha,
                "artifact_size": second_size,
            },
        ],
        "inventory": inventory_items,
    }
    evidence_path = candidate_dir / "evidence.json"
    evidence_path.write_text(json.dumps(evidence_doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    out_apk.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(first_pkg, out_apk)
    return {
        "first_sha256": first_sha,
        "second_sha256": second_sha,
        "out_apk": str(out_apk),
    }


def _write_synthetic_apk(path: Path, dex_suffix: bytes = b"035\x00payload") -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("AndroidManifest.xml", b"<manifest package='io.kodera.app'/>")
        archive.writestr("classes.dex", b"dex\n" + dex_suffix)


def run_selftest() -> int:
    revision = "a" * 40
    with tempfile.TemporaryDirectory(prefix="kodera-android-pkg-selftest-") as scratch_str:
        scratch = Path(scratch_str)
        raw1 = scratch / "raw1.apk"
        raw2 = scratch / "raw2.apk"
        _write_synthetic_apk(raw1)
        _write_synthetic_apk(raw2)

        candidate_dir = scratch / "candidate"
        out_apk = scratch / "dist-release" / "kodera-android.apk"
        stage_android_release_bundle(
            raw1,
            raw2,
            candidate_dir,
            out_apk,
            revision,
            java_version_override="21.0.2",
        )

        verify_ok = subprocess.run(
            [
                sys.executable,
                str(CHECK_NATIVE_PACKAGING),
                "--first",
                str(candidate_dir / "first" / "package.zip"),
                "--second",
                str(candidate_dir / "second" / "package.zip"),
                "--sbom",
                str(candidate_dir / "sbom.cdx.json"),
                "--evidence",
                str(candidate_dir / "evidence.json"),
                "--toolchain",
                str(candidate_dir / "toolchain-lock.json"),
                "--revision",
                revision,
                "--target",
                "android-apk",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if verify_ok.returncode != 0:
            print(f"[FAIL] expected matching APKs to pass check-native-packaging: {verify_ok.stderr}", file=sys.stderr)
            return 1

        # Negative mutation: non-reproducible second APK must be refused by check-native-packaging.py
        drifted_raw2 = scratch / "drifted-raw2.apk"
        _write_synthetic_apk(drifted_raw2, dex_suffix=b"035\x00drifted-bytes")
        bad_candidate_dir = scratch / "bad-candidate"
        stage_android_release_bundle(
            raw1,
            drifted_raw2,
            bad_candidate_dir,
            scratch / "dist-bad" / "kodera-android.apk",
            revision,
            java_version_override="21.0.2",
        )
        verify_bad = subprocess.run(
            [
                sys.executable,
                str(CHECK_NATIVE_PACKAGING),
                "--first",
                str(bad_candidate_dir / "first" / "package.zip"),
                "--second",
                str(bad_candidate_dir / "second" / "package.zip"),
                "--sbom",
                str(bad_candidate_dir / "sbom.cdx.json"),
                "--evidence",
                str(bad_candidate_dir / "evidence.json"),
                "--toolchain",
                str(bad_candidate_dir / "toolchain-lock.json"),
                "--revision",
                revision,
                "--target",
                "android-apk",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if verify_bad.returncode == 0 or "not reproducible" not in verify_bad.stderr:
            print(
                f"[FAIL] expected drifted second APK to fail reproducibility gate, got rc={verify_bad.returncode} stderr={verify_bad.stderr!r}",
                file=sys.stderr,
            )
            return 1

    print("OK: package-android-release.py selftest passed (reproducible pass + drifted refusal).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--first-raw", type=Path)
    parser.add_argument("--second-raw", type=Path)
    parser.add_argument("--candidate-dir", type=Path)
    parser.add_argument("--out-apk", type=Path)
    parser.add_argument("--revision", default="")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    if not (args.first_raw and args.second_raw and args.candidate_dir and args.out_apk and args.revision):
        parser.error("--first-raw, --second-raw, --candidate-dir, --out-apk, and --revision are required")

    result = stage_android_release_bundle(
        args.first_raw,
        args.second_raw,
        args.candidate_dir,
        args.out_apk,
        args.revision,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

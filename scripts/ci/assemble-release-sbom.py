#!/usr/bin/env python3
"""Assemble unified multi-ecosystem CycloneDX 1.6 SBOM for Kodera release bundles.

Merges:
  1. npm workspace CycloneDX output (`npm sbom --sbom-format=cyclonedx ...`)
  2. Rust `Cargo.lock` (real 64-hex SHA-256 crate checksums) + `cargo metadata` (SPDX licenses)
  3. Android `candidate/sbom.cdx.json` (real `.jar`/`.aar` SHA-256 digests + Maven POM SPDX licenses)

Fails closed if any ecosystem is empty, if any Cargo or Android component lacks a 64-hex
SHA-256 digest or SPDX license, or if a license falls outside the existing native-package
policy: recognised identifiers only, with an admitted alternative and no unreviewed exception.

Usage:
    python3 scripts/ci/assemble-release-sbom.py \
      --npm-sbom /tmp/npm.cdx.json \
      --cargo-lock Cargo.lock \
      --cargo-metadata /tmp/cargo-metadata.json \
      --android-sbom release-staging/android-sbom/sbom.cdx.json \
      --revision <40-hex-sha> \
      --out release-bundle/sbom-cyclonedx.json

    python3 scripts/ci/assemble-release-sbom.py --selftest
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
PERMISSIVE = frozenset(
    {
        "Apache-2.0",
        "MIT",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "0BSD",
        "Zlib",
        "BSL-1.0",
        "CC0-1.0",
        "Unlicense",
    }
)
# Recognised alternatives remain non-admitted unless an OR branch supplies a
# reviewed permissive choice. Unknown IDs cannot hide behind an admitted branch.
KNOWN_NONPERMISSIVE = frozenset(
    {
        "GPL-2.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0-only",
        "GPL-3.0-or-later",
        "LGPL-2.0-only",
        "LGPL-2.0-or-later",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "AGPL-3.0-only",
        "AGPL-3.0-or-later",
    }
)
# Reviewed permissive SPDX identifiers carried by locked web/Rust release dependencies
# (`@fontsource/*` design-system fonts, Unicode ICU tables, `dunce`, `fiat-crypto`).
REVIEWED_RELEASE_PERMISSIVE_EXTRAS = frozenset(
    {
        "BSD-1-Clause",
        "MIT-0",
        "OFL-1.1",
        "Unicode-3.0",
        "Unicode-DFS-2016",
    }
)
# Reviewed `(license_id, exception_id)` pairs admitted in release binaries (`target-lexicon`, `wasi`).
REVIEWED_WITH_EXCEPTIONS = frozenset(
    {
        ("Apache-2.0", "LLVM-exception"),
    }
)
# Unmodified file-level weak-copyleft MPL-2.0 Cargo crates reviewed under `security/backports/OPENMLS.md`.
# Any unreviewed MPL-2.0 crate, npm package, or Maven artifact remains refused by default.
REVIEWED_MPL20_CARGO_CRATES = frozenset(
    {
        "cssparser",
        "cssparser-macros",
        "dtoa-short",
        "hpke-rs",
        "hpke-rs-crypto",
        "hpke-rs-libcrux",
        "hpke-rs-rust-crypto",
        "option-ext",
        "selectors",
    }
)


def normalize_cargo_spdx(raw: str) -> str:
    """Normalize Cargo's legacy `/` license separator into standard SPDX `OR` syntax."""
    cleaned = " ".join(raw.split()).strip()
    if not cleaned:
        return ""
    return re.sub(r"\s*/\s*", " OR ", cleaned)


def spdx_expression_acceptable(expression: str) -> bool:
    """Apply the existing native-package SPDX subset, including unknown-ID refusal."""
    if (
        not isinstance(expression, str)
        or not 0 < len(expression) <= 512
        or not all(ord(char) >= 32 for char in expression)
    ):
        return False
    tokens = re.findall(r"\(|\)|[^\s()]+", expression)
    if len(tokens) > 128:
        return False
    index = 0

    def primary(depth):
        nonlocal index
        if depth > 16 or index == len(tokens):
            raise ValueError
        token = tokens[index]
        index += 1
        if token == "(":
            result = either(depth + 1)
            if index == len(tokens) or tokens[index] != ")":
                raise ValueError
            index += 1
            return result
        if token in {"AND", "OR", "WITH", ")"}:
            raise ValueError
        if token not in PERMISSIVE and token not in KNOWN_NONPERMISSIVE:
            raise ValueError
        return token in PERMISSIVE

    def both(depth):
        nonlocal index
        result = primary(depth)
        while index < len(tokens) and tokens[index] == "AND":
            index += 1
            right = primary(depth)
            result = result and right
        return result

    def either(depth):
        nonlocal index
        result = both(depth)
        while index < len(tokens) and tokens[index] == "OR":
            index += 1
            right = both(depth)
            result = result or right
        return result

    try:
        result = either(0)
        return index == len(tokens) and result
    except ValueError:
        return False


def release_spdx_expression_acceptable(
    expression: str,
    *,
    allow_reviewed_mpl20: bool = False,
) -> bool:
    """Evaluate SPDX expressions for unified release SBOMs with fail-closed unknown-ID refusal."""
    if (
        not isinstance(expression, str)
        or not 0 < len(expression) <= 512
        or not all(ord(char) >= 32 for char in expression)
    ):
        return False
    tokens = re.findall(r"\(|\)|[^\s()]+", expression)
    if len(tokens) > 128:
        return False

    admitted = PERMISSIVE | REVIEWED_RELEASE_PERMISSIVE_EXTRAS
    nonpermissive = set(KNOWN_NONPERMISSIVE)
    if allow_reviewed_mpl20:
        admitted = admitted | frozenset({"MPL-2.0"})
    else:
        nonpermissive.add("MPL-2.0")

    index = 0

    def primary(depth: int) -> bool:
        nonlocal index
        if depth > 16 or index == len(tokens):
            raise ValueError
        token = tokens[index]
        index += 1
        if token == "(":
            result = either(depth + 1)
            if index == len(tokens) or tokens[index] != ")":
                raise ValueError
            index += 1
            return result
        if token in {"AND", "OR", "WITH", ")"}:
            raise ValueError
        if index < len(tokens) and tokens[index] == "WITH":
            index += 1
            if index == len(tokens) or tokens[index] in {"(", ")", "AND", "OR", "WITH"}:
                raise ValueError
            exception_id = tokens[index]
            index += 1
            if (token, exception_id) not in REVIEWED_WITH_EXCEPTIONS:
                raise ValueError
            return True
        if token not in admitted and token not in nonpermissive:
            raise ValueError
        return token in admitted

    def both(depth: int) -> bool:
        nonlocal index
        result = primary(depth)
        while index < len(tokens) and tokens[index] == "AND":
            index += 1
            right = primary(depth)
            result = result and right
        return result

    def either(depth: int) -> bool:
        nonlocal index
        result = both(depth)
        while index < len(tokens) and tokens[index] == "OR":
            index += 1
            right = both(depth)
            result = result or right
        return result

    try:
        result = either(0)
        return index == len(tokens) and result
    except ValueError:
        return False


def sha256_crate_directory(crate_dir: Path) -> str:
    """Compute a deterministic SHA-256 digest over a path-patched third-party crate directory."""
    try:
        dir_stat = os.lstat(crate_dir)
    except OSError as exc:
        raise ValueError(f"path-patched crate directory missing: {crate_dir}") from exc
    if stat.S_ISLNK(dir_stat.st_mode) or not stat.S_ISDIR(dir_stat.st_mode):
        raise ValueError(f"path-patched crate path must be a real directory: {crate_dir}")

    collected: list[tuple[str, bytes]] = []

    def walk_dir(current: Path, rel_prefix: str) -> None:
        for name in sorted(os.listdir(current)):
            if name in {".git", "target"}:
                continue
            child = current / name
            st = os.lstat(child)
            rel_posix = f"{rel_prefix}/{name}" if rel_prefix else name
            if stat.S_ISLNK(st.st_mode):
                raise ValueError(f"refused symlink inside path-patched crate: {child}")
            if stat.S_ISDIR(st.st_mode):
                walk_dir(child, rel_posix)
            elif stat.S_ISREG(st.st_mode):
                collected.append((rel_posix, child.read_bytes()))
            else:
                raise ValueError(f"unsupported special file inside path-patched crate: {child}")

    walk_dir(crate_dir, "")
    if not collected or not any(rel == "Cargo.toml" for rel, _ in collected):
        raise ValueError(f"path-patched crate directory lacks Cargo.toml: {crate_dir}")

    hasher = hashlib.sha256(b"kodera-crate-dir-v1\0")
    for rel_posix, raw_bytes in collected:
        hasher.update(rel_posix.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(str(len(raw_bytes)).encode("ascii"))
        hasher.update(b"\0")
        hasher.update(raw_bytes)
        hasher.update(b"\0")
    return hasher.hexdigest()


def cyclonedx_license_choice(spdx_expr: str) -> dict[str, object]:
    if " " in spdx_expr or "(" in spdx_expr or ")" in spdx_expr:
        return {"expression": spdx_expr}
    return {"license": {"id": spdx_expr}}


def extract_cyclonedx_license_str(component: dict[str, object]) -> str:
    choices = component.get("licenses")
    if not isinstance(choices, list) or not choices:
        return ""
    parts: list[str] = []
    for item in choices:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("expression"), str) and item["expression"].strip():
            parts.append(item["expression"].strip())
        elif isinstance(item.get("license"), dict):
            lic_obj = item["license"]
            ident = lic_obj.get("id") or lic_obj.get("name")
            if isinstance(ident, str) and ident.strip():
                parts.append(ident.strip())
    return " OR ".join(parts)


def extract_sha256_hash(component: dict[str, object]) -> str | None:
    hashes = component.get("hashes")
    if not isinstance(hashes, list):
        return None
    for entry in hashes:
        if isinstance(entry, dict) and entry.get("alg") == "SHA-256":
            content = entry.get("content")
            if isinstance(content, str) and SHA256_RE.fullmatch(content):
                return content
    return None


def collect_cargo_components(
    cargo_lock_path: Path,
    cargo_metadata_path: Path,
) -> list[dict[str, object]]:
    with cargo_lock_path.open("rb") as handle:
        lock_doc = tomllib.load(handle)
    raw_lock_pkgs = lock_doc.get("package", [])
    if not isinstance(raw_lock_pkgs, list) or not raw_lock_pkgs:
        raise ValueError(f"Cargo.lock contains no [[package]] entries: {cargo_lock_path}")

    checksum_by_key: dict[tuple[str, str], str] = {}
    for pkg in raw_lock_pkgs:
        if not isinstance(pkg, dict) or not pkg.get("source"):
            continue
        name = str(pkg.get("name", "")).strip()
        version = str(pkg.get("version", "")).strip()
        checksum = str(pkg.get("checksum", "")).strip()
        if name and version and checksum:
            if not SHA256_RE.fullmatch(checksum):
                raise ValueError(
                    f"invalid Cargo.lock SHA-256 checksum for {name}@{version}: {checksum!r}"
                )
            checksum_by_key[(name, version)] = checksum

    metadata_doc = json.loads(cargo_metadata_path.read_text(encoding="utf-8"))
    meta_pkgs = metadata_doc.get("packages", [])
    if not isinstance(meta_pkgs, list) or not meta_pkgs:
        raise ValueError(f"cargo metadata contains no packages: {cargo_metadata_path}")
    raw_ws_members = metadata_doc.get("workspace_members", [])
    workspace_members = (
        {str(member) for member in raw_ws_members}
        if isinstance(raw_ws_members, list)
        else set()
    )

    components: list[dict[str, object]] = []
    seen_refs: set[str] = set()
    for pkg in meta_pkgs:
        if not isinstance(pkg, dict):
            continue
        pkg_id = str(pkg.get("id") or "")
        source = pkg.get("source")
        manifest_path_raw = pkg.get("manifest_path")
        if source is None:
            if pkg_id and pkg_id in workspace_members:
                continue
            if not workspace_members and not manifest_path_raw:
                continue
            if not isinstance(manifest_path_raw, str) or not manifest_path_raw.strip():
                raise ValueError(
                    f"non-workspace path crate lacks manifest_path in cargo metadata: {pkg!r}"
                )
        name = str(pkg.get("name", "")).strip()
        version = str(pkg.get("version", "")).strip()
        if not (name and version):
            raise ValueError(f"incomplete package entry in cargo metadata: {pkg!r}")
        if source is None:
            checksum = sha256_crate_directory(Path(str(manifest_path_raw)).parent)
        else:
            checksum = checksum_by_key.get((name, version))
        if not checksum:
            raise ValueError(f"missing Cargo.lock SHA-256 checksum for crate {name}@{version}")

        raw_license = str(pkg.get("license") or "").strip()
        spdx_expr = normalize_cargo_spdx(raw_license)
        if not spdx_expr:
            raise ValueError(f"missing SPDX license in cargo metadata for crate {name}@{version}")
        if not release_spdx_expression_acceptable(
            spdx_expr,
            allow_reviewed_mpl20=(name in REVIEWED_MPL20_CARGO_CRATES),
        ):
            raise ValueError(
                f"refused non-permissive SPDX license '{spdx_expr}' on crate {name}@{version}"
            )

        purl = f"pkg:cargo/{name}@{version}"
        if purl in seen_refs:
            continue
        seen_refs.add(purl)
        components.append(
            {
                "type": "library",
                "bom-ref": purl,
                "name": name,
                "version": version,
                "purl": purl,
                "hashes": [{"alg": "SHA-256", "content": checksum}],
                "licenses": [cyclonedx_license_choice(spdx_expr)],
            }
        )

    if not components:
        raise ValueError("no external Cargo crate components resolved from cargo metadata")
    return sorted(components, key=lambda item: str(item["bom-ref"]))


def collect_android_components(android_sbom_path: Path) -> list[dict[str, object]]:
    doc = json.loads(android_sbom_path.read_text(encoding="utf-8"))
    if doc.get("bomFormat") != "CycloneDX":
        raise ValueError(f"Android SBOM must have bomFormat=CycloneDX: {android_sbom_path}")
    raw_components = doc.get("components", [])
    if not isinstance(raw_components, list) or not raw_components:
        raise ValueError(f"Android SBOM contains no components: {android_sbom_path}")

    components: list[dict[str, object]] = []
    seen_refs: set[str] = set()
    for comp in raw_components:
        if not isinstance(comp, dict):
            raise ValueError("Android SBOM component must be an object")
        ref = str(comp.get("bom-ref") or comp.get("purl") or "").strip()
        name = str(comp.get("name") or "").strip()
        version = str(comp.get("version") or "").strip()
        digest = extract_sha256_hash(comp)
        lic_str = extract_cyclonedx_license_str(comp)
        if not (ref and name and version and digest and lic_str):
            raise ValueError(
                f"Android SBOM component missing ref, identity, SHA-256 hash, or SPDX license: {comp!r}"
            )
        if not release_spdx_expression_acceptable(lic_str, allow_reviewed_mpl20=False):
            raise ValueError(
                f"Android SBOM component {ref} carries non-permissive license '{lic_str}'"
            )
        if ref in seen_refs:
            continue
        seen_refs.add(ref)
        components.append(
            {
                "type": str(comp.get("type") or "library"),
                "bom-ref": ref,
                "name": name,
                "version": version,
                "purl": str(comp.get("purl") or ref),
                "hashes": [{"alg": "SHA-256", "content": digest}],
                "licenses": [cyclonedx_license_choice(lic_str)],
            }
        )
    return sorted(components, key=lambda item: str(item["bom-ref"]))


def is_workspace_local_npm_component(comp: dict[str, object]) -> bool:
    props = comp.get("properties")
    if not isinstance(props, list):
        return False
    for prop in props:
        if isinstance(prop, dict) and prop.get("name") == "cdx:npm:package:path":
            raw_path = str(prop.get("value") or "").strip().replace("\\", "/")
            segments = [seg for seg in raw_path.split("/") if seg and seg != "."]
            return bool(segments) and "node_modules" not in segments and ".." not in segments
    return False


def collect_npm_components(
    npm_sbom_path: Path,
) -> tuple[list[dict[str, object]], dict[str, list[str]]]:
    doc = json.loads(npm_sbom_path.read_text(encoding="utf-8"))
    if doc.get("bomFormat") != "CycloneDX":
        raise ValueError(f"npm SBOM must have bomFormat=CycloneDX: {npm_sbom_path}")
    raw_components = doc.get("components", [])
    if not isinstance(raw_components, list) or not raw_components:
        raise ValueError(f"npm SBOM contains no components: {npm_sbom_path}")

    components: list[dict[str, object]] = []
    seen_refs: set[str] = set()
    for comp in raw_components:
        if not isinstance(comp, dict):
            continue
        ref = str(comp.get("bom-ref") or comp.get("purl") or "").strip()
        name = str(comp.get("name") or "").strip()
        version = str(comp.get("version") or "").strip()
        if not (ref and name and version) or ref in seen_refs:
            continue
        # Workspace-local packages inside the monorepo are identified by cdx:npm:package:path
        # without a node_modules segment; external npm packages must carry an acceptable SPDX license.
        is_external = not is_workspace_local_npm_component(comp)
        lic_str = extract_cyclonedx_license_str(comp)
        if is_external and not lic_str:
            raise ValueError(f"npm SBOM component {ref} missing license metadata")
        if is_external and not release_spdx_expression_acceptable(
            lic_str, allow_reviewed_mpl20=False
        ):
            raise ValueError(f"npm SBOM component {ref} carries refused license '{lic_str}'")
        seen_refs.add(ref)
        cleaned = dict(comp)
        cleaned["bom-ref"] = ref
        components.append(cleaned)

    if not components:
        raise ValueError("no valid npm components found in npm SBOM")

    edges: dict[str, list[str]] = {}
    for dep in doc.get("dependencies", []) if isinstance(doc.get("dependencies"), list) else []:
        if not isinstance(dep, dict):
            continue
        d_ref = str(dep.get("ref") or "").strip()
        targets = dep.get("dependsOn")
        if d_ref in seen_refs and isinstance(targets, list):
            edges[d_ref] = sorted({str(t) for t in targets if str(t) in seen_refs})

    return sorted(components, key=lambda item: str(item["bom-ref"])), edges


def read_release_app_version(root: Path = ROOT) -> str:
    json_manifests = (
        ("package.json", root / "package.json"),
        ("apps/web/package.json", root / "apps" / "web" / "package.json"),
        ("apps/desktop/package.json", root / "apps" / "desktop" / "package.json"),
        (
            "apps/desktop/src-tauri/tauri.conf.json",
            root / "apps" / "desktop" / "src-tauri" / "tauri.conf.json",
        ),
    )
    versions: dict[str, str] = {}
    for label, path in json_manifests:
        doc = json.loads(path.read_text(encoding="utf-8"))
        ver = str(doc.get("version") or "").strip()
        if not SEMVER_RE.fullmatch(ver):
            raise ValueError(f"{label} lacks canonical X.Y.Z version: {ver!r}")
        versions[label] = ver

    gradle_text = (root / "apps" / "android" / "app" / "build.gradle.kts").read_text(
        encoding="utf-8"
    )
    gradle_match = re.search(r'versionName\s*=\s*"([^"]+)"', gradle_text)
    android_ver = gradle_match.group(1).strip() if gradle_match else ""
    if not SEMVER_RE.fullmatch(android_ver):
        raise ValueError(
            f"apps/android/app/build.gradle.kts lacks canonical versionName: {android_ver!r}"
        )
    versions["apps/android/app/build.gradle.kts"] = android_ver

    plist_doc = plistlib.loads((root / "apps" / "ios" / "App" / "Info.plist").read_bytes())
    ios_ver = str(plist_doc.get("CFBundleShortVersionString") or "").strip()
    if not SEMVER_RE.fullmatch(ios_ver):
        raise ValueError(
            f"apps/ios/App/Info.plist lacks canonical CFBundleShortVersionString: {ios_ver!r}"
        )
    versions["apps/ios/App/Info.plist"] = ios_ver

    expected = versions["package.json"]
    drifted = {label: ver for label, ver in versions.items() if ver != expected}
    if drifted:
        raise ValueError(
            f"release manifest version drift against package.json ({expected!r}): {drifted}"
        )
    return expected


def assemble_release_sbom(
    npm_sbom_path: Path,
    cargo_lock_path: Path,
    cargo_metadata_path: Path,
    android_sbom_path: Path,
    revision: str,
    out_path: Path,
    root: Path = ROOT,
) -> dict[str, int]:
    if not REVISION_RE.fullmatch(revision):
        raise ValueError("revision must be a 40-character lowercase hex commit SHA")

    app_version = read_release_app_version(root)
    npm_components, npm_edges = collect_npm_components(npm_sbom_path)
    cargo_components = collect_cargo_components(cargo_lock_path, cargo_metadata_path)
    android_components = collect_android_components(android_sbom_path)

    merged_by_ref: dict[str, dict[str, object]] = {}
    for group in (npm_components, cargo_components, android_components):
        for comp in group:
            ref = str(comp["bom-ref"])
            if ref in merged_by_ref:
                raise ValueError(f"duplicate component bom-ref across ecosystems: {ref}")
            merged_by_ref[ref] = comp

    sorted_refs = sorted(merged_by_ref)
    merged_components = [merged_by_ref[ref] for ref in sorted_refs]

    subject_ref = f"pkg:generic/kodera-release@{revision[:12]}"
    dependencies: list[dict[str, object]] = [
        {"ref": subject_ref, "dependsOn": sorted_refs},
    ]
    for ref in sorted_refs:
        dependencies.append({"ref": ref, "dependsOn": npm_edges.get(ref, [])})

    unified_doc = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": subject_ref,
                "name": "Kodera",
                "version": app_version,
                "licenses": [{"license": {"id": "Apache-2.0"}}],
                "properties": [
                    {"name": "kodera:source-revision", "value": revision},
                    {"name": "kodera:ecosystems", "value": "npm,cargo,maven"},
                ],
            }
        },
        "components": merged_components,
        "dependencies": dependencies,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(unified_doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "npm_components": len(npm_components),
        "cargo_components": len(cargo_components),
        "android_components": len(android_components),
        "total_components": len(merged_components),
    }


def run_selftest() -> int:
    import runpy

    canonical = runpy.run_path(str(Path(__file__).with_name("check-native-packaging.py")))
    assert PERMISSIVE == canonical["PERMISSIVE"]
    assert KNOWN_NONPERMISSIVE == canonical["KNOWN_NONPERMISSIVE"]
    expressions = sorted(PERMISSIVE | KNOWN_NONPERMISSIVE) + [
        "MIT OR Apache-2.0",
        "(MIT OR GPL-3.0-only) AND BSD-3-Clause",
        "MIT OR (GPL-3.0-only AND LGPL-2.1-only)",
        "MIT AND (Apache-2.0 OR GPL-3.0-only)",
        "MIT AND GPL-3.0-only",
        "MPL-2.0",
        "Unicode-3.0",
        "LicenseRef-Private",
        "MIT OR LicenseRef-Private",
        "MIT OR (Apache-2.0 AND LicenseRef-Private)",
        "Apache-2.0 WITH Unreviewed-exception",
        "MIT OR (GPL-3.0-only WITH Classpath-exception-2.0)",
        "MIT OR SSPL-1.0",
        "MIT+",
        "mit",
        "MIT or Apache-2.0",
        "MIT OR",
        "MIT AND (Apache-2.0 OR)",
        "MIT )",
        "()",
        "",
        " " * 513,
        "MIT\nOR Apache-2.0",
        "(" * 17 + "MIT" + ")" * 17,
        " OR ".join(["MIT"] * 65),
    ]
    for expression in expressions:
        assert spdx_expression_acceptable(expression) == canonical["acceptable_license"](expression), expression
    for expression in ("MIT", "MIT OR GPL-3.0-only", "(MIT OR GPL-3.0-only) AND BSD-3-Clause"):
        assert spdx_expression_acceptable(expression), expression
    refused_expressions = (
        "MPL-2.0",
        "LicenseRef-Private",
        "MIT OR LicenseRef-Private",
        "Apache-2.0 WITH Unreviewed-exception",
        "MIT OR (Apache-2.0 AND LicenseRef-Private)",
    )
    for expression in refused_expressions:
        assert not spdx_expression_acceptable(expression), expression

    revision = "b" * 40
    with tempfile.TemporaryDirectory(prefix="kodera-assemble-sbom-selftest-") as scratch_str:
        scratch = Path(scratch_str)

        npm_sbom = scratch / "npm.cdx.json"
        npm_sha = hashlib.sha256(b"npm-tarball-bytes").hexdigest()
        npm_sbom.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "components": [
                        {
                            "type": "library",
                            "bom-ref": "pkg:npm/react@19.0.0",
                            "name": "react",
                            "version": "19.0.0",
                            "purl": "pkg:npm/react@19.0.0",
                            "hashes": [{"alg": "SHA-256", "content": npm_sha}],
                            "licenses": [{"license": {"id": "MIT"}}],
                        }
                    ],
                    "dependencies": [{"ref": "pkg:npm/react@19.0.0", "dependsOn": []}],
                }
            ),
            encoding="utf-8",
        )

        cargo_sha = hashlib.sha256(b"serde-crate-bytes").hexdigest()
        cargo_lock = scratch / "Cargo.lock"
        cargo_lock.write_text(
            f"""version = 4

[[package]]
name = "kodera-desktop"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "{cargo_sha}"
""",
            encoding="utf-8",
        )

        cargo_meta = scratch / "cargo-metadata.json"
        cargo_meta.write_text(
            json.dumps(
                {
                    "packages": [
                        {"name": "kodera-desktop", "version": "0.1.0", "source": None, "license": "Apache-2.0"},
                        {
                            "name": "serde",
                            "version": "1.0.219",
                            "source": "registry+https://github.com/rust-lang/crates.io-index",
                            "license": "MIT/Apache-2.0",
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )

        android_sha = hashlib.sha256(b"okhttp-jar-bytes").hexdigest()
        android_sbom = scratch / "android.cdx.json"
        android_sbom.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.6",
                    "version": 1,
                    "components": [
                        {
                            "type": "library",
                            "bom-ref": "pkg:maven/com.squareup.okhttp3/okhttp@5.5.1",
                            "name": "com.squareup.okhttp3:okhttp",
                            "version": "5.5.1",
                            "purl": "pkg:maven/com.squareup.okhttp3/okhttp@5.5.1",
                            "hashes": [{"alg": "SHA-256", "content": android_sha}],
                            "licenses": [{"license": {"id": "Apache-2.0"}}],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        out_sbom = scratch / "sbom-cyclonedx.json"
        counts = assemble_release_sbom(
            npm_sbom, cargo_lock, cargo_meta, android_sbom, revision, out_sbom
        )
        if counts != {
            "npm_components": 1,
            "cargo_components": 1,
            "android_components": 1,
            "total_components": 3,
        }:
            print(f"[FAIL] unexpected merged counts: {counts}", file=sys.stderr)
            return 1

        merged = json.loads(out_sbom.read_text(encoding="utf-8"))
        if merged["metadata"]["component"]["version"] != read_release_app_version(ROOT):
            print("[FAIL] unified SBOM metadata.component.version drifted from manifests", file=sys.stderr)
            return 1
        drift_root = scratch / "drift-manifests"
        for rel in ("apps/web", "apps/desktop/src-tauri", "apps/android/app", "apps/ios/App"):
            (drift_root / rel).mkdir(parents=True, exist_ok=True)
        for rel in (
            "package.json",
            "apps/web/package.json",
            "apps/desktop/package.json",
            "apps/desktop/src-tauri/tauri.conf.json",
        ):
            (drift_root / rel).write_text('{"version": "0.1.1"}\n', encoding="utf-8")
        (drift_root / "apps/android/app/build.gradle.kts").write_text(
            'versionName = "0.1.1"\n', encoding="utf-8"
        )
        (drift_root / "apps/ios/App/Info.plist").write_bytes(
            plistlib.dumps({"CFBundleShortVersionString": "0.1.0"})
        )
        try:
            read_release_app_version(drift_root)
            print("[FAIL] read_release_app_version accepted drifted iOS Info.plist", file=sys.stderr)
            return 1
        except ValueError:
            pass
        by_ref = {c["bom-ref"]: c for c in merged["components"]}
        if by_ref["pkg:cargo/serde@1.0.219"]["hashes"][0]["content"] != cargo_sha:
            print("[FAIL] Cargo crate SHA-256 checksum not preserved", file=sys.stderr)
            return 1
        if by_ref["pkg:cargo/serde@1.0.219"]["licenses"] != [{"expression": "MIT OR Apache-2.0"}]:
            print("[FAIL] Cargo crate '/' SPDX expression not normalized", file=sys.stderr)
            return 1
        if (
            by_ref["pkg:maven/com.squareup.okhttp3/okhttp@5.5.1"]["hashes"][0]["content"]
            != android_sha
        ):
            print("[FAIL] Android Maven SHA-256 digest not preserved", file=sys.stderr)
            return 1

        # Negative 1: missing Cargo.lock checksum must fail closed.
        bad_lock = scratch / "Cargo-missing-csum.lock"
        bad_lock.write_text(
            """version = 4
[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"
""",
            encoding="utf-8",
        )
        missing_csum_failed = False
        try:
            assemble_release_sbom(
                npm_sbom, bad_lock, cargo_meta, android_sbom, revision, scratch / "bad1.json"
            )
        except ValueError as exc:
            missing_csum_failed = "missing Cargo.lock SHA-256 checksum" in str(exc)
        if not missing_csum_failed:
            print("[FAIL] expected missing Cargo.lock checksum to fail closed", file=sys.stderr)
            return 1

        # Negative 2: copyleft GPL crate in cargo metadata must fail closed.
        gpl_meta = scratch / "cargo-gpl.json"
        gpl_meta.write_text(
            json.dumps(
                {
                    "packages": [
                        {
                            "name": "serde",
                            "version": "1.0.219",
                            "source": "registry+https://github.com/rust-lang/crates.io-index",
                            "license": "GPL-3.0-only",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        gpl_failed = False
        try:
            assemble_release_sbom(
                npm_sbom, cargo_lock, gpl_meta, android_sbom, revision, scratch / "bad2.json"
            )
        except ValueError as exc:
            gpl_failed = "refused non-permissive SPDX license" in str(exc)
        if not gpl_failed:
            print("[FAIL] expected copyleft crate license to fail closed", file=sys.stderr)
            return 1

        # Exercise every real collector through assembly, not only the predicate.
        original_inputs = {
            "cargo": (cargo_meta, json.loads(cargo_meta.read_text(encoding="utf-8"))),
            "npm": (npm_sbom, json.loads(npm_sbom.read_text(encoding="utf-8"))),
            "android": (android_sbom, json.loads(android_sbom.read_text(encoding="utf-8"))),
        }
        refusal_count = 0
        for expression in refused_expressions:
            for ecosystem, (path, original) in original_inputs.items():
                changed = json.loads(json.dumps(original))
                if ecosystem == "cargo":
                    changed["packages"][1]["license"] = expression
                else:
                    changed["components"][0]["licenses"] = [{"expression": expression}]
                path.write_text(json.dumps(changed), encoding="utf-8")
                refused_output = scratch / f"refused-{refusal_count}.json"
                try:
                    assemble_release_sbom(
                        npm_sbom, cargo_lock, cargo_meta, android_sbom, revision, refused_output
                    )
                except ValueError as error:
                    assert "license" in str(error), (ecosystem, expression, str(error))
                else:
                    raise AssertionError(("unreviewed license assembled", ecosystem, expression))
                finally:
                    path.write_text(json.dumps(original), encoding="utf-8")
                assert not refused_output.exists(), (ecosystem, expression)
                refusal_count += 1

        # Keep missing-license/digest and empty-ecosystem refusals independent
        # of the strengthened SPDX parser.
        for ecosystem, (path, original) in original_inputs.items():
            for mutation in ("empty", "missing-license", "missing-digest"):
                if ecosystem == "npm" and mutation == "missing-digest":
                    continue  # npm sbom omits tarball SHA-256 digests; missing-license still fails closed.
                changed = json.loads(json.dumps(original))
                selected_lock = cargo_lock
                if mutation == "empty":
                    changed["packages" if ecosystem == "cargo" else "components"] = []
                elif ecosystem == "cargo":
                    if mutation == "missing-license":
                        changed["packages"][1].pop("license")
                    else:
                        selected_lock = bad_lock
                else:
                    changed["components"][0].pop("licenses" if mutation == "missing-license" else "hashes")
                path.write_text(json.dumps(changed), encoding="utf-8")
                refused_output = scratch / f"guard-{ecosystem}-{mutation}.json"
                try:
                    assemble_release_sbom(
                        npm_sbom, selected_lock, cargo_meta, android_sbom, revision, refused_output
                    )
                except ValueError:
                    pass
                else:
                    raise AssertionError(("existing guard bypassed", ecosystem, mutation))
                finally:
                    path.write_text(json.dumps(original), encoding="utf-8")
                assert not refused_output.exists()

        # Verify workspace-local cdx:npm:package:path detection vs nested node_modules external enforcement.
        ws_npm_sbom = scratch / "npm-workspace-boundary.cdx.json"
        ws_npm_sbom.write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "components": [
                        {
                            "type": "library",
                            "bom-ref": "@kodera/internal-ws@0.1.0",
                            "name": "@kodera/internal-ws",
                            "version": "0.1.0",
                            "purl": "pkg:npm/%40kodera/internal-ws@0.1.0",
                            "properties": [{"name": "cdx:npm:package:path", "value": "apps/server"}],
                        },
                        {
                            "type": "library",
                            "bom-ref": "nested-dep@1.0.0",
                            "name": "nested-dep",
                            "version": "1.0.0",
                            "purl": "pkg:npm/nested-dep@1.0.0",
                            "properties": [
                                {"name": "cdx:npm:package:path", "value": "apps/web/node_modules/nested-dep"}
                            ],
                            "licenses": [{"license": {"id": "MIT"}}],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        ws_comps, _ = collect_npm_components(ws_npm_sbom)
        assert len(ws_comps) == 2, ws_comps
        ws_bad_doc = json.loads(ws_npm_sbom.read_text(encoding="utf-8"))
        ws_bad_doc["components"][1].pop("licenses")
        ws_npm_sbom.write_text(json.dumps(ws_bad_doc), encoding="utf-8")
        try:
            collect_npm_components(ws_npm_sbom)
        except ValueError as err:
            assert "missing license metadata" in str(err), err
        else:
            raise AssertionError("nested node_modules package missing license was not refused")

        # Verify reviewed release SPDX extensions, reviewed Cargo MPL-2.0 scope, and
        # [patch.crates-io] path-patched third-party crate inventory + symlink refusal.
        for expr in (
            "OFL-1.1",
            "Unicode-3.0",
            "(MIT OR Apache-2.0) AND Unicode-3.0",
            "CC0-1.0 OR MIT-0 OR Apache-2.0",
            "MIT OR Apache-2.0 OR BSD-1-Clause",
            "Apache-2.0 WITH LLVM-exception",
            "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
            "MIT OR MPL-2.0",
        ):
            assert release_spdx_expression_acceptable(expr, allow_reviewed_mpl20=False), expr
        assert not release_spdx_expression_acceptable("MPL-2.0", allow_reviewed_mpl20=False)
        assert release_spdx_expression_acceptable("MPL-2.0", allow_reviewed_mpl20=True)
        for bad_expr in (
            "Apache-2.0 WITH Unreviewed-exception",
            "MIT OR (GPL-3.0-only WITH Classpath-exception-2.0)",
            "MIT OR LicenseRef-Private",
            "MIT OR SSPL-1.0",
        ):
            assert not release_spdx_expression_acceptable(bad_expr, allow_reviewed_mpl20=True), (
                bad_expr
            )

        backport_dir = scratch / "backport-glib"
        backport_dir.mkdir()
        (backport_dir / "Cargo.toml").write_text('[package]\nname = "glib"\nversion = "0.18.5"\n', encoding="utf-8")
        (backport_dir / "lib.rs").write_text("pub fn patched() {}\n", encoding="utf-8")
        hpke_sha = hashlib.sha256(b"hpke-rs-crate-bytes").hexdigest()
        patched_lock = scratch / "Cargo-patched.lock"
        patched_lock.write_text(
            f"""version = 4
[[package]]
name = "kodera-desktop"
version = "0.1.0"
[[package]]
name = "glib"
version = "0.18.5"
[[package]]
name = "hpke-rs"
version = "0.8.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "{hpke_sha}"
""",
            encoding="utf-8",
        )
        patched_meta = scratch / "cargo-patched-meta.json"
        patched_meta.write_text(
            json.dumps(
                {
                    "workspace_members": ["path+file:///ws/kodera-desktop#0.1.0"],
                    "packages": [
                        {
                            "id": "path+file:///ws/kodera-desktop#0.1.0",
                            "name": "kodera-desktop",
                            "version": "0.1.0",
                            "source": None,
                            "manifest_path": str(scratch / "ws" / "Cargo.toml"),
                            "license": "Apache-2.0",
                        },
                        {
                            "id": "path+file:///ws/security/backports/glib#0.18.5",
                            "name": "glib",
                            "version": "0.18.5",
                            "source": None,
                            "manifest_path": str(backport_dir / "Cargo.toml"),
                            "license": "MIT",
                        },
                        {
                            "id": "registry+https://github.com/rust-lang/crates.io-index#hpke-rs@0.8.0",
                            "name": "hpke-rs",
                            "version": "0.8.0",
                            "source": "registry+https://github.com/rust-lang/crates.io-index",
                            "license": "MPL-2.0",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        patched_components = collect_cargo_components(patched_lock, patched_meta)
        patched_refs = {str(c["bom-ref"]) for c in patched_components}
        assert patched_refs == {"pkg:cargo/glib@0.18.5", "pkg:cargo/hpke-rs@0.8.0"}, patched_refs

        (backport_dir / "evil-link").symlink_to(backport_dir / "lib.rs")
        try:
            collect_cargo_components(patched_lock, patched_meta)
        except ValueError as err:
            assert "symlink" in str(err)
        else:
            raise AssertionError("symlink inside path-patched crate was not refused")
        finally:
            (backport_dir / "evil-link").unlink()

        # Live repository lockfile verification so unreviewed licenses fail on PRs before tag push.
        repo_root = Path(__file__).resolve().parents[2]
        pkg_lock_path = repo_root / "package-lock.json"
        if pkg_lock_path.is_file():
            pkg_lock_doc = json.loads(pkg_lock_path.read_text(encoding="utf-8"))
            checked_npm = 0
            for pkg_path, pkg_meta in pkg_lock_doc.get("packages", {}).items():
                pkg_path_str = str(pkg_path).replace("\\", "/")
                is_node_module = pkg_path_str.startswith("node_modules/") or "/node_modules/" in pkg_path_str
                if not is_node_module or not isinstance(pkg_meta, dict):
                    continue
                if pkg_meta.get("dev") is True or pkg_meta.get("link") is True:
                    continue
                lic = str(pkg_meta.get("license") or "").strip()
                if not lic or not release_spdx_expression_acceptable(
                    lic, allow_reviewed_mpl20=False
                ):
                    raise AssertionError(
                        f"live package-lock.json production dependency {pkg_path} carries unreviewed license {lic!r}"
                    )
                checked_npm += 1
            assert checked_npm >= 150, (
                f"expected root and workspace-nested production packages in live package-lock.json, got {checked_npm}"
            )
            if shutil.which("npm"):
                npm_proc = subprocess.run(
                    [
                        "npm",
                        "sbom",
                        "--omit=dev",
                        "--sbom-format=cyclonedx",
                        "--package-lock-only",
                        "--workspaces",
                        "--include-workspace-root",
                    ],
                    cwd=repo_root,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                live_npm_sbom_path = scratch / "live-npm-sbom.cdx.json"
                live_npm_sbom_path.write_text(npm_proc.stdout, encoding="utf-8")
                live_npm_components, _ = collect_npm_components(live_npm_sbom_path)
                assert len(live_npm_components) >= 150, len(live_npm_components)

        live_cargo_lock = repo_root / "Cargo.lock"
        live_cargo_toml = repo_root / "Cargo.toml"
        if live_cargo_lock.is_file() and live_cargo_toml.is_file() and shutil.which("cargo"):
            proc = subprocess.run(
                [
                    "cargo",
                    "metadata",
                    "--locked",
                    "--all-features",
                    "--format-version",
                    "1",
                    "--manifest-path",
                    str(live_cargo_toml),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            live_meta_path = scratch / "live-cargo-metadata.json"
            live_meta_path.write_text(proc.stdout, encoding="utf-8")
            live_cargo_components = collect_cargo_components(live_cargo_lock, live_meta_path)
            live_cargo_refs = {str(c["bom-ref"]) for c in live_cargo_components}
            for expected_backport in (
                "pkg:cargo/glib@0.18.5",
                "pkg:cargo/openmls_basic_credential@0.6.0",
                "pkg:cargo/openmls_rust_crypto@0.6.0",
            ):
                assert expected_backport in live_cargo_refs, (
                    f"missing backported crate {expected_backport} in live Cargo SBOM"
                )

    print(
        "OK: assemble-release-sbom.py selftest passed "
        f"(merge, checksum/copyleft guards, {len(expressions)} canonical SPDX comparisons, "
        f"{refusal_count} unreviewed-license assembly refusals, 8 collector guards, and live lockfile verification)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--npm-sbom", type=Path)
    parser.add_argument("--cargo-lock", type=Path)
    parser.add_argument("--cargo-metadata", type=Path)
    parser.add_argument("--android-sbom", type=Path)
    parser.add_argument("--revision", default="")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    if not (
        args.npm_sbom
        and args.cargo_lock
        and args.cargo_metadata
        and args.android_sbom
        and args.revision
        and args.out
    ):
        parser.error(
            "--npm-sbom, --cargo-lock, --cargo-metadata, --android-sbom, --revision, and --out are required"
        )

    counts = assemble_release_sbom(
        args.npm_sbom,
        args.cargo_lock,
        args.cargo_metadata,
        args.android_sbom,
        args.revision,
        args.out,
    )
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

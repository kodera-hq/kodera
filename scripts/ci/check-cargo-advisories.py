#!/usr/bin/env python3
"""Audit Cargo.lock crates against OSV/RustSec and verify local `[patch.crates-io]` backports.

Every crates.io dependency pinned in `Cargo.lock` is queried in batches against OSV
(`ecosystem: "crates.io"`). Every `source = None` crate in `Cargo.lock` must be either a
declared workspace member in `Cargo.toml` or an explicit `[patch.crates-io]` path backport
under `security/backports/` with an existing `Cargo.toml`.

Any security vulnerability or informational notice not bound by exact `(advisory, package,
version, informational)` with a non-empty `reason` in `security/cargo-advisory-allowlist.json`
fails CI, and any stale or drifted allowlist entry fails CI.

Usage:
    python3 scripts/ci/check-cargo-advisories.py
    python3 scripts/ci/check-cargo-advisories.py --selftest
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST_REL = Path("security") / "cargo-advisory-allowlist.json"
OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch"
OSV_VULN_URL_PREFIX = "https://api.osv.dev/v1/vulns/"
BATCH_SIZE = 250


class CargoAdvisoryRefusal(Exception):
    """Raised when an advisory check cannot look or finds an unaccounted problem."""


def _http_json_curl(url: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    cmd = ["curl", "-fsSL", "--max-time", "25"]
    if payload is not None:
        cmd.extend(
            [
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                json.dumps(payload, separators=(",", ":")),
            ]
        )
    cmd.append(url)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CargoAdvisoryRefusal(f"OSV query failed for {url}: {exc}") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise CargoAdvisoryRefusal(f"OSV query exited {proc.returncode} for {url}: {detail}")
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise CargoAdvisoryRefusal(f"OSV returned unreadable JSON for {url}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise CargoAdvisoryRefusal(f"OSV returned non-object JSON for {url}")
    return parsed


def _load_workspace_and_patches(root: Path) -> tuple[set[str], dict[str, str]]:
    manifest_path = root / "Cargo.toml"
    try:
        manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise CargoAdvisoryRefusal(f"Cargo.toml is unreadable ({exc})") from exc

    workspace = manifest.get("workspace")
    if not isinstance(workspace, dict):
        raise CargoAdvisoryRefusal("Cargo.toml carries no [workspace] table")
    member_dirs = workspace.get("members")
    if not isinstance(member_dirs, list) or not member_dirs:
        raise CargoAdvisoryRefusal("Cargo.toml [workspace].members is missing or empty")

    workspace_names: set[str] = set()
    for rel in member_dirs:
        if not isinstance(rel, str):
            raise CargoAdvisoryRefusal("Cargo.toml [workspace].members contains non-string entry")
        member_toml_path = root / rel / "Cargo.toml"
        try:
            member_toml = tomllib.loads(member_toml_path.read_text(encoding="utf-8"))
            pkg_name = member_toml["package"]["name"]
        except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError) as exc:
            raise CargoAdvisoryRefusal(
                f"workspace member {rel}/Cargo.toml is unreadable ({exc})"
            ) from exc
        if not isinstance(pkg_name, str) or not pkg_name:
            raise CargoAdvisoryRefusal(f"workspace member {rel}/Cargo.toml lacks package.name")
        workspace_names.add(pkg_name)

    patch_names: dict[str, str] = {}
    patches = (manifest.get("patch") or {}).get("crates-io") or {}
    if not isinstance(patches, dict):
        raise CargoAdvisoryRefusal("Cargo.toml [patch.crates-io] must be a table")
    for crate_name, spec in sorted(patches.items()):
        if not isinstance(spec, dict) or not isinstance(spec.get("path"), str):
            raise CargoAdvisoryRefusal(
                f"Cargo.toml [patch.crates-io].{crate_name} must declare a local backport path"
            )
        patch_rel = spec["path"]
        if not patch_rel.startswith("security/backports/"):
            raise CargoAdvisoryRefusal(
                f"Cargo.toml [patch.crates-io].{crate_name} path {patch_rel!r} must live under security/backports/"
            )
        patch_toml_path = root / patch_rel / "Cargo.toml"
        if not patch_toml_path.is_file():
            raise CargoAdvisoryRefusal(
                f"Cargo.toml [patch.crates-io].{crate_name} missing {patch_rel}/Cargo.toml"
            )
        try:
            package = tomllib.loads(patch_toml_path.read_text(encoding="utf-8"))["package"]
            if package["name"] != crate_name or not isinstance(package["version"], str):
                raise ValueError("backport identity mismatch")
            patch_names[crate_name] = package["version"]
        except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError, ValueError) as exc:
            raise CargoAdvisoryRefusal(f"backport {crate_name} baseline identity is invalid") from exc

    return workspace_names, patch_names


def _load_locked_crates(root: Path) -> list[tuple[str, str]]:
    workspace_names, patch_names = _load_workspace_and_patches(root)
    lock_path = root / "Cargo.lock"
    try:
        lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise CargoAdvisoryRefusal(f"Cargo.lock is unreadable ({exc})") from exc

    packages = lock.get("package")
    if not isinstance(packages, list) or not packages:
        raise CargoAdvisoryRefusal("Cargo.lock pins no packages")

    registry_crates: list[tuple[str, str]] = []
    seen_patches: set[str] = set()
    for pkg in packages:
        if not isinstance(pkg, dict):
            raise CargoAdvisoryRefusal("Cargo.lock package entry is not a table")
        name = pkg.get("name")
        version = pkg.get("version")
        source = pkg.get("source")
        if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
            raise CargoAdvisoryRefusal(f"Cargo.lock package missing name or version: {pkg!r}")
        if source is None:
            if name in workspace_names:
                continue
            if name in patch_names:
                if version != patch_names[name]:
                    raise CargoAdvisoryRefusal(f"backport {name} version differs from Cargo.lock")
                seen_patches.add(name)
                registry_crates.append((name, version))
                continue
            raise CargoAdvisoryRefusal(
                f"Cargo.lock carries unreviewed local/path crate `{name}@{version}` outside workspace and [patch.crates-io]"
            )
        if not isinstance(source, str) or not source.startswith("registry+"):
            raise CargoAdvisoryRefusal(
                f"Cargo.lock carries non-registry source for `{name}@{version}`: {source!r}"
            )
        registry_crates.append((name, version))

    missing_patches = sorted(patch_names.keys() - seen_patches)
    if missing_patches:
        raise CargoAdvisoryRefusal(
            f"[patch.crates-io] declares backports unused by Cargo.lock: {', '.join(missing_patches)}"
        )
    if not registry_crates:
        raise CargoAdvisoryRefusal("Cargo.lock pins zero crates.io packages")
    return registry_crates


def _load_allowlist(root: Path) -> dict[tuple[str, str], dict[str, object]]:
    path = root / ALLOWLIST_REL
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CargoAdvisoryRefusal(f"{ALLOWLIST_REL} is not readable JSON ({exc})") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("advisories"), list):
        raise CargoAdvisoryRefusal(f"{ALLOWLIST_REL} must carry an `advisories` list")

    allowed: dict[tuple[str, str], dict[str, object]] = {}
    expected_keys = {"advisory", "package", "version", "informational", "reason"}
    for entry in raw["advisories"]:
        if not isinstance(entry, dict):
            raise CargoAdvisoryRefusal(f"{ALLOWLIST_REL} entry is not an object")
        extra = sorted(set(entry) - expected_keys)
        missing = sorted(expected_keys - set(entry))
        if extra or missing:
            raise CargoAdvisoryRefusal(
                f"{ALLOWLIST_REL} entry must carry exact keys {sorted(expected_keys)} "
                f"(missing={missing}, extra={extra})"
            )
        advisory = entry["advisory"]
        package = entry["package"]
        version = entry["version"]
        informational = entry["informational"]
        reason = entry["reason"]
        if (
            not isinstance(advisory, str)
            or not advisory.strip()
            or not isinstance(package, str)
            or not package.strip()
            or not isinstance(version, str)
            or not version.strip()
        ):
            raise CargoAdvisoryRefusal(
                f"{ALLOWLIST_REL} entry has empty advisory/package/version"
            )
        if informational is not None and not isinstance(informational, str):
            raise CargoAdvisoryRefusal(
                f"{ALLOWLIST_REL} entry {advisory} `informational` must be string or null"
            )
        if not isinstance(reason, str) or not reason.strip():
            raise CargoAdvisoryRefusal(
                f"{ALLOWLIST_REL} entry {advisory} carries no written reason"
            )
        key = (advisory, package)
        if key in allowed:
            raise CargoAdvisoryRefusal(
                f"{ALLOWLIST_REL} lists ({advisory}, {package}) more than once"
            )
        allowed[key] = {**entry, "used": False}
    return allowed


def _extract_informational(vuln_doc: dict[str, object], pkg_name: str) -> str | None:
    affected = vuln_doc.get("affected")
    if isinstance(affected, list):
        for item in affected:
            if not isinstance(item, dict):
                continue
            pkg = item.get("package")
            if isinstance(pkg, dict) and pkg.get("name") == pkg_name:
                dbs = item.get("database_specific")
                if isinstance(dbs, dict) and isinstance(dbs.get("informational"), str):
                    return dbs["informational"]
    top_dbs = vuln_doc.get("database_specific")
    if isinstance(top_dbs, dict) and isinstance(top_dbs.get("informational"), str):
        return top_dbs["informational"]
    return None


def audit_cargo_lock(
    root: Path,
    fetch_json: Callable[[str, dict[str, object] | None], dict[str, object]] = _http_json_curl,
) -> tuple[int, list[str]]:
    crates = _load_locked_crates(root)
    allowed = _load_allowlist(root)
    _, patch_names = _load_workspace_and_patches(root)

    findings: list[dict[str, object]] = []
    vuln_cache: dict[str, dict[str, object]] = {}

    for start in range(0, len(crates), BATCH_SIZE):
        chunk = crates[start : start + BATCH_SIZE]
        queries = [
            {"package": {"name": name, "ecosystem": "crates.io"}, "version": version}
            for name, version in chunk
        ]
        batch_resp = fetch_json(OSV_BATCH_URL, {"queries": queries})
        results = batch_resp.get("results")
        if not isinstance(results, list) or len(results) != len(chunk):
            raise CargoAdvisoryRefusal(
                f"OSV batch returned {len(results) if isinstance(results, list) else 'non-list'} "
                f"results for {len(chunk)} queried crates"
            )
        for (pkg_name, pkg_ver), res in zip(chunk, results, strict=True):
            if not isinstance(res, dict):
                raise CargoAdvisoryRefusal(f"OSV result for {pkg_name}@{pkg_ver} is not an object")
            vulns = res.get("vulns") or []
            if not isinstance(vulns, list):
                raise CargoAdvisoryRefusal(f"OSV vulns field for {pkg_name}@{pkg_ver} is not a list")
            for vuln_stub in vulns:
                if not isinstance(vuln_stub, dict) or not isinstance(vuln_stub.get("id"), str):
                    raise CargoAdvisoryRefusal(
                        f"OSV returned advisory stub without string id for {pkg_name}@{pkg_ver}"
                    )
                vid = vuln_stub["id"]
                if vid not in vuln_cache:
                    vuln_cache[vid] = fetch_json(f"{OSV_VULN_URL_PREFIX}{vid}", None)
                detail = vuln_cache[vid]
                informational = _extract_informational(detail, pkg_name)
                findings.append(
                    {
                        "advisory": vid,
                        "package": pkg_name,
                        "version": pkg_ver,
                        "informational": informational,
                        "summary": str(detail.get("summary") or ""),
                    }
                )

    problems: list[str] = []
    for finding in findings:
        adv = str(finding["advisory"])
        pkg = str(finding["package"])
        ver = str(finding["version"])
        info = finding["informational"]
        excuse = allowed.get((adv, pkg))
        if excuse is None or (excuse["informational"] in (None, "unsound") and pkg not in patch_names):
            kind = f"informational:{info}" if info else "security vulnerability"
            problems.append(
                f"{adv} on {pkg}@{ver} ({kind}) is not bound in {ALLOWLIST_REL}"
            )
            continue
        excuse["used"] = True
        if excuse["version"] != ver:
            problems.append(
                f"{ALLOWLIST_REL} entry {adv} on {pkg} binds version {excuse['version']!r}, "
                f"Cargo.lock pins {ver!r}"
            )
        if excuse["informational"] != info:
            problems.append(
                f"{ALLOWLIST_REL} entry {adv} on {pkg} binds informational={excuse['informational']!r}, "
                f"OSV reports {info!r}"
            )

    for (adv, pkg), entry in sorted(allowed.items()):
        if not entry["used"]:
            problems.append(
                f"stale entry ({adv}, {pkg}) in {ALLOWLIST_REL} matches no finding in Cargo.lock"
            )

    return len(crates), problems


def _write_synthetic_fixture(
    folder: Path,
    *,
    allowlist_entries: list[dict[str, object]] | None = None,
    extra_lock_pkg: str = "",
) -> None:
    (folder / "packages" / "demo").mkdir(parents=True)
    (folder / "security" / "backports" / "patched-0.1.0").mkdir(parents=True)
    (folder / "Cargo.toml").write_text(
        '[workspace]\nmembers = ["packages/demo"]\n\n'
        '[patch.crates-io]\npatched = { path = "security/backports/patched-0.1.0" }\n',
        encoding="utf-8",
    )
    (folder / "packages" / "demo" / "Cargo.toml").write_text(
        '[package]\nname = "demo"\nversion = "0.1.0"\n',
        encoding="utf-8",
    )
    (folder / "security" / "backports" / "patched-0.1.0" / "Cargo.toml").write_text(
        '[package]\nname = "patched"\nversion = "0.1.0"\n',
        encoding="utf-8",
    )
    (folder / "Cargo.lock").write_text(
        'version = 3\n\n'
        '[[package]]\nname = "demo"\nversion = "0.1.0"\n\n'
        '[[package]]\nname = "patched"\nversion = "0.1.0"\n\n'
        '[[package]]\nname = "safe-crate"\nversion = "1.2.3"\n'
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n\n'
        '[[package]]\nname = "vuln-crate"\nversion = "0.4.0"\n'
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
        + extra_lock_pkg,
        encoding="utf-8",
    )
    if allowlist_entries is not None:
        (folder / ALLOWLIST_REL).write_text(
            json.dumps({"advisories": allowlist_entries}),
            encoding="utf-8",
        )


def selftest() -> int:
    def mock_clean(url: str, payload: dict[str, object] | None) -> dict[str, object]:
        if url != OSV_BATCH_URL or payload is None:
            raise CargoAdvisoryRefusal("selftest unexpected batch request")
        queries = payload["queries"]
        if not isinstance(queries, list):
            raise CargoAdvisoryRefusal("selftest malformed queries")
        return {"results": [{} for _ in queries]}

    def mock_vuln(url: str, payload: dict[str, object] | None) -> dict[str, object]:
        if url == OSV_BATCH_URL:
            if payload is None:
                raise CargoAdvisoryRefusal("selftest missing query payload")
            queries = payload["queries"]
            if not isinstance(queries, list):
                raise CargoAdvisoryRefusal("selftest malformed queries")
            out = []
            for q in queries:
                if not isinstance(q, dict):
                    raise CargoAdvisoryRefusal("selftest malformed query")
                pkg = q["package"]
                if not isinstance(pkg, dict):
                    raise CargoAdvisoryRefusal("selftest malformed package")
                if pkg["name"] == "patched":
                    out.append({"vulns": [{"id": "RUSTSEC-2099-0001"}]})
                else:
                    out.append({})
            return {"results": out}
        if url == f"{OSV_VULN_URL_PREFIX}RUSTSEC-2099-0001":
            return {
                "id": "RUSTSEC-2099-0001",
                "summary": "Memory corruption in patched",
                "affected": [
                    {
                        "package": {"name": "patched", "ecosystem": "crates.io"},
                        "database_specific": {"informational": None},
                    }
                ],
            }
        raise AssertionError(f"unexpected URL {url}")

    # 1. Clean synthetic Cargo.lock with reviewed local backport passes.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d)
        count, probs = audit_cargo_lock(d, fetch_json=mock_clean)
        if count != 3 or probs:
            print(f"[FAIL] selftest clean case failed: count={count} probs={probs}", file=sys.stderr)
            return 1

    # 2. Planted unallowlisted vulnerability fails closed.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d)
        _, probs = audit_cargo_lock(d, fetch_json=mock_vuln)
        if not any("RUSTSEC-2099-0001 on patched@0.1.0 (security vulnerability)" in p for p in probs):
            print(f"[FAIL] selftest planted vulnerability did not fail: {probs}", file=sys.stderr)
            return 1

    # 3. Bound allowlist entry passes, while version drift fails closed.
    bound_entry = {
        "advisory": "RUSTSEC-2099-0001",
        "package": "patched",
        "version": "0.1.0",
        "informational": None,
        "reason": "Synthetic test fixture exception.",
    }
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d, allowlist_entries=[bound_entry])
        _, probs = audit_cargo_lock(d, fetch_json=mock_vuln)
        if probs:
            print(f"[FAIL] selftest bound entry failed unexpectedly: {probs}", file=sys.stderr)
            return 1

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d, allowlist_entries=[{**bound_entry, "version": "0.3.9"}])
        _, probs = audit_cargo_lock(d, fetch_json=mock_vuln)
        if not any("binds version '0.3.9', Cargo.lock pins '0.1.0'" in p for p in probs):
            print(f"[FAIL] selftest version drift did not fail: {probs}", file=sys.stderr)
            return 1

    # 4. Stale allowlist entry fails closed.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d, allowlist_entries=[bound_entry])
        _, probs = audit_cargo_lock(d, fetch_json=mock_clean)
        if not any("stale entry (RUSTSEC-2099-0001, patched)" in p for p in probs):
            print(f"[FAIL] selftest stale entry did not fail: {probs}", file=sys.stderr)
            return 1

    # 5. Unreviewed `source = None` crate outside workspace and `[patch.crates-io]` refuses.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(
            d,
            extra_lock_pkg='\n[[package]]\nname = "mystery-fork"\nversion = "0.1.0"\n',
        )
        try:
            audit_cargo_lock(d, fetch_json=mock_clean)
        except CargoAdvisoryRefusal as exc:
            if "mystery-fork@0.1.0" not in str(exc):
                print(f"[FAIL] selftest mystery fork wrong error: {exc}", file=sys.stderr)
                return 1
        else:
            print("[FAIL] selftest mystery fork did not refuse", file=sys.stderr)
            return 1

    # 6. Truncated OSV batch response refuses rather than assuming clean.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d)
        try:
            audit_cargo_lock(d, fetch_json=lambda _u, _p: {"results": [{}]})
        except CargoAdvisoryRefusal as exc:
            if "returned 1 results for 3 queried crates" not in str(exc):
                print(f"[FAIL] selftest truncated OSV batch wrong error: {exc}", file=sys.stderr)
                return 1
        else:
            print("[FAIL] selftest truncated OSV batch did not refuse", file=sys.stderr)
            return 1

    # Registry vulnerabilities remain audited alongside patched baseline cases.
    def registry_vuln(url, payload):
        if url == OSV_BATCH_URL:
            return {"results": [
                {"vulns": [{"id": "REGISTRY-0001"}]}
                if q["package"]["name"] == "vuln-crate" else {}
                for q in payload["queries"]
            ]}
        return {"affected": [{"package": {"name": "vuln-crate"}}]}

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d)
        _, probs = audit_cargo_lock(d, fetch_json=registry_vuln)
        if not any("REGISTRY-0001 on vuln-crate@0.4.0" in p for p in probs):
            print(f"[FAIL] selftest registry vulnerability not refused: {probs}", file=sys.stderr)
            return 1

    # Every patched baseline is queried; its bound fix cannot hide a new advisory.
    def patched_vulns(url, payload):
        if url == OSV_BATCH_URL:
            queries = payload["queries"]
            if not any(q["package"]["name"] == "patched" and q["version"] == "0.1.0" for q in queries):
                raise CargoAdvisoryRefusal("selftest did not query patched baseline")
            return {"results": [
                {"vulns": [{"id": "FIXED-0001"}, {"id": "NEW-0002"}]}
                if q["package"]["name"] == "patched" else {} for q in queries
            ]}
        return {"affected": [{"package": {"name": "patched"}}]}

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_synthetic_fixture(d, allowlist_entries=[{
            "advisory": "FIXED-0001", "package": "patched", "version": "0.1.0",
            "informational": None, "reason": "Verified synthetic backport of this fix only.",
        }])
        _, probs = audit_cargo_lock(d, fetch_json=patched_vulns)
        if len(probs) != 1 or "NEW-0002 on patched@0.1.0" not in probs[0]:
            print(f"[FAIL] selftest unrelated patched advisory not refused: {probs}", file=sys.stderr)
            return 1
        # Removing the patch must revoke the backport exception immediately.
        cargo = d / "Cargo.toml"
        original = cargo.read_text()
        cargo.write_text(original.split("[patch.crates-io]")[0])
        lock = d / "Cargo.lock"
        original_lock = lock.read_text()
        lock.write_text(original_lock.replace(
            'name = "patched"\nversion = "0.1.0"\n',
            'name = "patched"\nversion = "0.1.0"\n'
            'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
        ))
        _, probs = audit_cargo_lock(d, fetch_json=patched_vulns)
        if not any("FIXED-0001 on patched@0.1.0" in problem for problem in probs):
            print(f"[FAIL] selftest removed patch retained exception: {probs}", file=sys.stderr)
            return 1
        cargo.write_text(original)
        lock.write_text(original_lock)
        manifest = d / "security/backports/patched-0.1.0/Cargo.toml"
        manifest.write_text(manifest.read_text().replace('version = "0.1.0"', 'version = "0.2.0"'))
        try:
            _load_locked_crates(d)
        except CargoAdvisoryRefusal:
            pass
        else:
            print("[FAIL] selftest backport version drift accepted", file=sys.stderr)
            return 1

    print("OK: check-cargo-advisories selftest passed (10 cases).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()

    try:
        checked_count, problems = audit_cargo_lock(ROOT)
    except CargoAdvisoryRefusal as exc:
        print(f"check-cargo-advisories: {exc}", file=sys.stderr)
        return 1

    if problems:
        for line in problems:
            print(f"check-cargo-advisories: FAIL: {line}", file=sys.stderr)
        return 1

    print(
        f"OK: check-cargo-advisories audited {checked_count} crates.io packages in Cargo.lock "
        "(plus verified [patch.crates-io] backports); zero unaccounted advisories."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

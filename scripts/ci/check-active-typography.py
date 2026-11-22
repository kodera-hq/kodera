#!/usr/bin/env python3
"""Refuse reintroduction of the retired Plus Jakarta typeface anywhere in active tracked files.

Kodera unifies product and editorial typography on `Inter Variable` + `IBM Plex Mono`.
Historical changelogs (`CHANGELOG.md`) and this guard itself are exempt; every active
token source, stylesheet, TypeScript/Swift/Kotlin/Rust/Python source, manifest, plist,
lockfile, and specification is checked by filename and UTF-8 content.

Usage:
    python3 scripts/ci/check-active-typography.py [--root DIR]
    python3 scripts/ci/check-active-typography.py --selftest
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN = re.compile(r"plus[-_ ]?jakarta", re.IGNORECASE)
EXEMPT_PATHS = {
    "scripts/ci/check-active-typography.py",
}


def is_exempt(rel_posix: str) -> bool:
    if rel_posix in EXEMPT_PATHS:
        return True
    name = Path(rel_posix).name
    if name == "CHANGELOG.md":
        return True
    return False


def tracked_files(root: Path) -> list[str]:
    if (root / ".git").exists():
        raw = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z"],
        )
        return [entry.decode("utf-8", "surrogateescape") for entry in raw.split(b"\0") if entry]
    return [
        p.relative_to(root).as_posix()
        for p in sorted(root.rglob("*"))
        if p.is_file() and ".git" not in p.parts
    ]


def scan_tree(root: Path) -> list[str]:
    findings: list[str] = []
    files = tracked_files(root)
    if not files:
        return [f"{root}: empty file list (refusing vacuous pass)"]
    for rel in files:
        if is_exempt(rel):
            continue
        path = root / rel
        if not path.is_file():
            continue
        if FORBIDDEN.search(rel):
            findings.append(f"{rel}: forbidden retired font filename matching {FORBIDDEN.pattern!r}")
            continue
        data = path.read_bytes()
        if b"\x00" in data[:8192]:
            continue
        text = data.decode("utf-8", "replace")
        match = FORBIDDEN.search(text)
        if match:
            line_no = text.count("\n", 0, match.start()) + 1
            findings.append(f"{rel}:{line_no}: forbidden retired typeface reference {match.group(0)!r}")
    return findings


def run_selftest() -> int:
    with tempfile.TemporaryDirectory(prefix="kodera-typo-guard-") as tmp:
        base = Path(tmp)
        (base / "packages/design-tokens").mkdir(parents=True)
        (base / "packages/design-tokens/tokens.json").write_text(
            '{"font": {"sans": ["Inter Variable", "sans-serif"]}}\n',
            encoding="utf-8",
        )
        (base / "CHANGELOG.md").write_text(
            "Historical note mentioning Plus Jakarta Sans before v0.8.0.\n",
            encoding="utf-8",
        )
        assert scan_tree(base) == [], f"clean fixture failed: {scan_tree(base)}"

        # Mutation 1: CSS / token content reintroduces Plus Jakarta Sans
        (base / "apps/web/src").mkdir(parents=True)
        bad_css = base / "apps/web/src/index.css"
        bad_css.write_text("@import '@fontsource/plus-jakarta-sans/400.css';\n", encoding="utf-8")
        res1 = scan_tree(base)
        assert len(res1) == 1 and "apps/web/src/index.css:1:" in res1[0], f"missed content mutation: {res1}"
        bad_css.unlink()

        # Mutation 2: Binary font asset filename reintroduces PlusJakartaSans
        (base / "apps/ios/App/Resources/Fonts").mkdir(parents=True)
        bad_ttf = base / "apps/ios/App/Resources/Fonts/PlusJakartaSans-Regular.ttf"
        bad_ttf.write_bytes(b"\x00\x01\x00\x00binary-ttf")
        res2 = scan_tree(base)
        assert len(res2) == 1 and "PlusJakartaSans-Regular.ttf" in res2[0], f"missed filename mutation: {res2}"
        bad_ttf.unlink()

        # Mutation 3: Empty directory refuses vacuous pass
        with tempfile.TemporaryDirectory(prefix="kodera-typo-empty-") as empty_tmp:
            res3 = scan_tree(Path(empty_tmp))
            assert len(res3) == 1 and "vacuous" in res3[0], f"missed vacuous directory: {res3}"

    print("PASS: check-active-typography selftest (3 refusal mutations verified)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()

    findings = scan_tree(args.root.resolve())
    if findings:
        for item in findings:
            print(f"::error::{item}", file=sys.stderr)
        print(f"FAIL: {len(findings)} retired-typeface finding(s)", file=sys.stderr)
        return 1
    print("PASS: active tree carries zero retired Plus Jakarta references")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

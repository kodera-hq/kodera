#!/usr/bin/env python3
"""Refuse reintroduction of the retired Plus Jakarta typeface anywhere in active tracked files.

Kodera unifies product and editorial typography on `Inter Variable` + `IBM Plex Mono`.
Historical changelogs (`CHANGELOG.md`) and this guard itself are exempt; every active
token source, stylesheet, TypeScript/Swift/Kotlin/Rust/Python source, manifest, plist,
lockfile, symlink, and binary font file (SFNT TTF/OTF, WOFF1, WOFF2) is checked.

Usage:
    python3 scripts/ci/check-active-typography.py [--root DIR]
    python3 scripts/ci/check-active-typography.py --selftest
"""

from __future__ import annotations

import argparse
import io
import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SELF_PATH = Path(__file__).resolve()
FORBIDDEN = re.compile(r"plus[-_ ]?jakarta", re.IGNORECASE)
FORBIDDEN_BYTES = re.compile(rb"plus[-_ ]?jakarta", re.IGNORECASE)
FORBIDDEN_UTF16BE = re.compile(
    rb"(?:\x00[pP]\x00[lL]\x00[uU]\x00[sS])(?:\x00[-_ ])?\x00[jJ]\x00[aA]\x00[kK]\x00[aA]\x00[rR]\x00[tT]\x00[aA]"
)
FORBIDDEN_UTF16LE = re.compile(
    rb"(?:[pP]\x00[lL]\x00[uU]\x00[sS]\x00)(?:[-_ ]\x00)?[jJ]\x00[aA]\x00[kK]\x00[aA]\x00[rR]\x00[tT]\x00[aA]\x00"
)
FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".woff", ".woff2"}
FONT_MAGICS = {b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf", b"wOFF", b"wOF2"}
PRUNE_DIRS = {".git", "node_modules"}


def is_exempt(path: Path, rel_posix: str) -> bool:
    if not path.is_symlink():
        try:
            if path.resolve() == SELF_PATH:
                return True
        except OSError:
            pass
    if Path(rel_posix).name == "CHANGELOG.md" and not path.is_symlink():
        return True
    return False


def tracked_files(root: Path) -> list[str]:
    probe = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode == 0 and probe.stdout.strip() == "true":
        raw = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"])
        return [entry.decode("utf-8", "surrogateescape") for entry in raw.split(b"\0") if entry]

    results: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Also inspect directory symlinks without descending into pruned trees.
        kept_dirs: list[str] = []
        base_dir = Path(dirpath)
        for d in sorted(dirnames):
            if d in PRUNE_DIRS:
                continue
            dp = base_dir / d
            if dp.is_symlink():
                results.append(dp.relative_to(root).as_posix())
            else:
                kept_dirs.append(d)
        dirnames[:] = kept_dirs
        for fname in sorted(filenames):
            fp = base_dir / fname
            if fp.is_file() or fp.is_symlink():
                results.append(fp.relative_to(root).as_posix())
    return sorted(results)


def _bytes_match_forbidden(blob: bytes) -> bool:
    return bool(
        FORBIDDEN_BYTES.search(blob)
        or FORBIDDEN_UTF16BE.search(blob)
        or FORBIDDEN_UTF16LE.search(blob)
    )


def _inspect_woff1_name_table(data: bytes) -> bool:
    if len(data) < 44 or data[:4] != b"wOFF":
        return False
    try:
        _sig, _flavor, _length, num_tables = struct.unpack_from(">4sIIH", data, 0)
        offset = 44
        for _ in range(num_tables):
            if offset + 20 > len(data):
                break
            tag, tbl_offset, comp_len, orig_len, _checksum = struct.unpack_from(
                ">4sIIII", data, offset
            )
            offset += 20
            if tag != b"name" or tbl_offset + comp_len > len(data):
                continue
            raw_tbl = data[tbl_offset : tbl_offset + comp_len]
            if comp_len < orig_len or raw_tbl[:1] == b"\x78":
                try:
                    raw_tbl = zlib.decompress(raw_tbl)
                except zlib.error:
                    if comp_len < orig_len:
                        return False
            if _bytes_match_forbidden(raw_tbl):
                return True
    except (struct.error, zlib.error):
        return False
    return False


def _inspect_fonttools_names(data: bytes) -> bool:
    try:
        from fontTools.ttLib import TTFont  # type: ignore[import-not-found]
    except ImportError:
        return False
    try:
        with TTFont(io.BytesIO(data), lazy=True) as tt:
            if "name" not in tt:
                return False
            for record in tt["name"].names:
                try:
                    value = record.toUnicode()
                except Exception:
                    value = record.string.decode("latin-1", "ignore")
                if FORBIDDEN.search(value):
                    return True
    except Exception:
        return False
    return False


def inspect_binary_font(data: bytes) -> bool:
    if _bytes_match_forbidden(data):
        return True
    if _inspect_woff1_name_table(data):
        return True
    if _inspect_fonttools_names(data):
        return True
    return False


def scan_tree(root: Path) -> list[str]:
    if not root.exists():
        return [f"{root}: root path does not exist"]
    files = tracked_files(root)
    if not files:
        return [f"{root}: empty file list (refusing vacuous pass)"]

    findings: list[str] = []
    for rel in files:
        path = root / rel
        if is_exempt(path, rel):
            continue
        if not (path.exists() or path.is_symlink()):
            # Unstaged deletion in working tree; skip cleanly while keeping dangling symlinks active.
            continue
        if FORBIDDEN.search(rel):
            findings.append(f"{rel}: forbidden retired font filename matching {FORBIDDEN.pattern!r}")
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if FORBIDDEN.search(target):
                findings.append(
                    f"{rel}: symlink target {target!r} references retired typeface"
                )
                continue
            if not path.exists() or path.is_dir():
                continue
        if not path.is_file():
            continue

        data = path.read_bytes()
        is_font = path.suffix.lower() in FONT_SUFFIXES or data[:4] in FONT_MAGICS
        if is_font:
            if inspect_binary_font(data):
                findings.append(
                    f"{rel}: binary font metadata references retired Plus Jakarta typeface"
                )
            continue

        if b"\x00" in data[:8192]:
            continue
        text = data.decode("utf-8", "replace")
        match = FORBIDDEN.search(text)
        if match:
            line_no = text.count("\n", 0, match.start()) + 1
            findings.append(f"{rel}:{line_no}: forbidden retired typeface reference {match.group(0)!r}")
    return findings


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "selftest",
            "GIT_AUTHOR_EMAIL": "selftest@kodera.local",
            "GIT_COMMITTER_NAME": "selftest",
            "GIT_COMMITTER_EMAIL": "selftest@kodera.local",
        },
    )


def _build_minimal_woff1_with_name(family_utf16be: bytes) -> bytes:
    orig = b"\x00" * 64 + family_utf16be
    comp = zlib.compress(orig, level=9)
    total_len = 44 + 20 + len(comp)
    header = struct.pack(
        ">4sIIHHIHHIIIII",
        b"wOFF",
        0x00010000,
        total_len,
        1,
        0,
        64 + len(orig),
        1,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    entry = struct.pack(">4sIIII", b"name", 64, len(comp), len(orig), 0)
    return header + entry + comp


def run_selftest() -> int:
    with tempfile.TemporaryDirectory(prefix="kodera-typo-guard-") as tmp:
        base = Path(tmp)
        _git(base, "init", "-q")
        (base / "packages/design-tokens").mkdir(parents=True)
        (base / "packages/design-tokens/tokens.json").write_text(
            '{"font": {"sans": ["Inter Variable", "sans-serif"]}}\n',
            encoding="utf-8",
        )
        (base / "CHANGELOG.md").write_text(
            "Historical note mentioning Plus Jakarta Sans before v0.8.0.\n",
            encoding="utf-8",
        )
        _git(base, "add", "packages/design-tokens/tokens.json", "CHANGELOG.md")
        assert scan_tree(base) == [], f"clean Git fixture failed: {scan_tree(base)}"

        # Mutation 1: Tracked CSS / token content reintroduces Plus Jakarta Sans
        (base / "apps/web/src").mkdir(parents=True)
        bad_css = base / "apps/web/src/index.css"
        bad_css.write_text("@import '@fontsource/plus-jakarta-sans/400.css';\n", encoding="utf-8")
        _git(base, "add", "apps/web/src/index.css")
        res1 = scan_tree(base)
        assert len(res1) == 1 and "apps/web/src/index.css:1:" in res1[0], f"missed content mutation: {res1}"
        # Mutation 2: Subdirectory invocation inside a Git repository still uses git ls-files
        res_sub = scan_tree(base / "apps")
        assert len(res_sub) == 1 and "web/src/index.css:1:" in res_sub[0], f"missed subdir Git scan: {res_sub}"
        _git(base, "rm", "-f", "-q", "apps/web/src/index.css")

        # Mutation 3: Binary font asset filename reintroduces PlusJakartaSans
        (base / "apps/ios/App/Resources/Fonts").mkdir(parents=True)
        bad_ttf = base / "apps/ios/App/Resources/Fonts/PlusJakartaSans-Regular.ttf"
        bad_ttf.write_bytes(b"\x00\x01\x00\x00binary-ttf")
        _git(base, "add", "apps/ios/App/Resources/Fonts/PlusJakartaSans-Regular.ttf")
        res3 = scan_tree(base)
        assert len(res3) == 1 and "PlusJakartaSans-Regular.ttf" in res3[0], f"missed filename mutation: {res3}"
        _git(base, "rm", "-f", "-q", "apps/ios/App/Resources/Fonts/PlusJakartaSans-Regular.ttf")

        # Mutation 4: Dangling symlink whose target names PlusJakartaSans
        bad_link = base / "apps/ios/App/Resources/Fonts/Primary-Regular.ttf"
        bad_link.parent.mkdir(parents=True, exist_ok=True)
        bad_link.symlink_to("../legacy/PlusJakartaSans-Regular.ttf")
        _git(base, "add", "apps/ios/App/Resources/Fonts/Primary-Regular.ttf")
        res4 = scan_tree(base)
        assert len(res4) == 1 and "symlink target" in res4[0], f"missed dangling symlink target: {res4}"
        _git(base, "rm", "-f", "-q", "apps/ios/App/Resources/Fonts/Primary-Regular.ttf")

        # Mutation 5: Renamed SFNT .ttf (UTF-16BE name table) and WOFF1 (zlib-compressed name table)
        disguised_ttf = base / "apps/ios/App/Resources/Fonts/Inter-Regular.ttf"
        disguised_ttf.parent.mkdir(parents=True, exist_ok=True)
        disguised_ttf.write_bytes(
            b"\x00\x01\x00\x00\x00\x01name" + "Plus Jakarta Sans".encode("utf-16-be")
        )
        disguised_woff = base / "apps/web/src/Inter-Regular.woff"
        disguised_woff.parent.mkdir(parents=True, exist_ok=True)
        disguised_woff.write_bytes(
            _build_minimal_woff1_with_name("Plus Jakarta Sans".encode("utf-16-be"))
        )
        _git(
            base,
            "add",
            "apps/ios/App/Resources/Fonts/Inter-Regular.ttf",
            "apps/web/src/Inter-Regular.woff",
        )
        res5 = scan_tree(base)
        assert len(res5) == 2 and all("binary font metadata" in item for item in res5), (
            f"missed disguised SFNT/WOFF1 font metadata: {res5}"
        )
        _git(
            base,
            "rm",
            "-f",
            "-q",
            "apps/ios/App/Resources/Fonts/Inter-Regular.ttf",
            "apps/web/src/Inter-Regular.woff",
        )

        # Mutation 6: Empty directory refuses vacuous pass
        with tempfile.TemporaryDirectory(prefix="kodera-typo-empty-") as empty_tmp:
            res6 = scan_tree(Path(empty_tmp))
            assert len(res6) == 1 and "vacuous" in res6[0], f"missed vacuous directory: {res6}"

    print("PASS: check-active-typography selftest (6 Git-backed & binary refusal mutations verified)")
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

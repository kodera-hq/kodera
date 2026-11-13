#!/usr/bin/env python3
"""Refuse copyleft, proprietary, or undeclared licences anywhere in package-lock.json.

Every external package in the root `package-lock.json`, development tools included, must carry
an SPDX licence expression compatible with shipping `@kodera/web` under `Apache-2.0`.

Refused licences and scopes:
- `GPL`, `AGPL`, `LGPL` in any version or `-only` / `-or-later` / `WITH` exception form;
- `SSPL` in any version;
- `UNLICENSED` or `SEE LICENSE IN ...` on external packages;
- any package in the `@blocknote/` scope regardless of declared licence string;
- any external package with no `license` declaration (unless explicitly listed in
  `KNOWN_UNDECLARED` after verifying its upstream licence file).

SPDX evaluation rules:
- `A OR B` passes if either `A` or `B` passes;
- `A AND B` passes only when both `A` and `B` pass;
- parentheses `( ... )` bind as in standard SPDX 2.3 grammar.

Usage:
    python3 scripts/ci/check-licenses.py [--lock package-lock.json]
    python3 scripts/ci/check-licenses.py --selftest
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import tempfile
from pathlib import Path

FORBIDDEN_LICENSE = re.compile(
    r"^(?:A|L)?GPL(?:-\d|\b|$)|^SSPL(?:-\d|\b|$)|^UNLICENSED$|^SEE\s+LICENSE\b",
    re.IGNORECASE,
)
FORBIDDEN_SCOPES = ("@blocknote/",)

# Only populate if an upstream package omits `license` in package.json while carrying a
# verified permissive LICENSE file in its tarball.
KNOWN_UNDECLARED: dict[str, str] = {}

_TOKEN_RE = re.compile(
    r"\s*(?:(\()|(\))|\b(AND|OR|WITH)\b|([^\s()]+))",
    re.IGNORECASE,
)


def package_name(lock_key: str) -> str:
    return lock_key.rsplit("node_modules/", 1)[-1]


def _tokenize_spdx(expression: str) -> list[tuple[str, str]] | None:
    tokens: list[tuple[str, str]] = []
    pos = 0
    length = len(expression)
    while pos < length:
        if expression[pos].isspace():
            pos += 1
            continue
        match = _TOKEN_RE.match(expression, pos)
        if match is None:
            return None
        lparen, rparen, keyword, ident = match.groups()
        if lparen:
            tokens.append(("LPAREN", "("))
        elif rparen:
            tokens.append(("RPAREN", ")"))
        elif keyword:
            tokens.append((keyword.upper(), keyword.upper()))
        elif ident:
            tokens.append(("ID", ident))
        pos = match.end()
    return tokens


def _single_id_acceptable(identifier: str) -> bool:
    cleaned = identifier.strip().rstrip("+")
    if not cleaned:
        return False
    return FORBIDDEN_LICENSE.search(cleaned) is None


def acceptable(expression: str) -> bool:
    """Evaluate an SPDX licence expression with proper parentheses, AND, OR, and WITH rules."""
    text = expression.strip()
    if not text or FORBIDDEN_LICENSE.search(text) and text.upper().startswith("SEE LICENSE"):
        return False

    tokens = _tokenize_spdx(text)
    if not tokens:
        return False

    index = 0

    def parse_or() -> bool | None:
        nonlocal index
        left = parse_and()
        if left is None:
            return None
        result = left
        while index < len(tokens) and tokens[index][0] == "OR":
            index += 1
            right = parse_and()
            if right is None:
                return None
            result = result or right
        return result

    def parse_and() -> bool | None:
        nonlocal index
        left = parse_primary()
        if left is None:
            return None
        result = left
        while index < len(tokens) and tokens[index][0] == "AND":
            index += 1
            right = parse_primary()
            if right is None:
                return None
            result = result and right
        return result

    def parse_primary() -> bool | None:
        nonlocal index
        if index >= len(tokens):
            return None
        kind, value = tokens[index]
        if kind == "LPAREN":
            index += 1
            inner = parse_or()
            if inner is None or index >= len(tokens) or tokens[index][0] != "RPAREN":
                return None
            index += 1
            return inner
        if kind == "ID":
            index += 1
            if index < len(tokens) and tokens[index][0] == "WITH":
                index += 1
                if index >= len(tokens) or tokens[index][0] != "ID":
                    return None
                index += 1
            return _single_id_acceptable(value)
        return None

    evaluated = parse_or()
    if evaluated is None or index != len(tokens):
        return False
    return evaluated


def license_of(entry: dict[str, object]) -> str:
    declared = entry.get("license")
    if isinstance(declared, str):
        return declared.strip()
    if isinstance(declared, dict):
        lic_type = declared.get("type")
        if isinstance(lic_type, str):
            return lic_type.strip()
    licenses = entry.get("licenses")
    if isinstance(licenses, list):
        parts: list[str] = []
        for item in licenses:
            if isinstance(item, dict) and isinstance(item.get("type"), str):
                lic = item["type"].strip()
                if lic:
                    parts.append(lic)
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        return " OR ".join(parts)
    return ""


def problems(lock: dict[str, object]) -> list[str]:
    found: list[str] = []
    raw_packages = lock.get("packages")
    if not isinstance(raw_packages, dict):
        return ["package-lock.json: missing `packages` map"]

    for path, entry in sorted(raw_packages.items()):
        if not path or not isinstance(entry, dict):
            continue
        if entry.get("link") is True:
            continue
        # Workspace package definitions inside the monorepo live outside node_modules/
        if "node_modules/" not in path:
            continue
        name = package_name(path)
        if any(name.startswith(scope) for scope in FORBIDDEN_SCOPES):
            scope_name = name.split("/", 1)[0]
            found.append(f"{path}: forbidden scope `{scope_name}`")
            continue
        declared = license_of(entry) or KNOWN_UNDECLARED.get(name, "")
        if not declared:
            found.append(f"{path}: no licence declared")
        elif not acceptable(declared):
            found.append(f"{path}: `{declared}` is refused")
    return found


def check(lock_path: Path, quiet_errors: bool = False) -> int:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    found = problems(lock)
    err_stream = io.StringIO() if quiet_errors else sys.stderr
    for line in found:
        print(f"check-licenses: {line}", file=err_stream)
    if found:
        return 1
    packages = lock.get("packages", {})
    external_count = sum(
        1
        for path, entry in (packages.items() if isinstance(packages, dict) else [])
        if path and isinstance(entry, dict) and not entry.get("link") and "node_modules/" in path
    )
    if not quiet_errors:
        print(f"check-licenses: {external_count} external packages checked, every licence accepted")
    return 0


def selftest() -> int:
    def make_lock(**packages: dict[str, object]) -> dict[str, object]:
        return {"packages": {"": {"name": "root"}, **packages}}

    cases: list[tuple[str, dict[str, object], int]] = [
        (
            "permissive-mit-apache-bsd-isc",
            make_lock(
                **{
                    "node_modules/a": {"license": "MIT"},
                    "node_modules/b": {"license": "Apache-2.0"},
                    "node_modules/c": {"license": "BSD-2-Clause"},
                    "node_modules/d": {"license": "ISC"},
                    "node_modules/e": {"license": "0BSD"},
                }
            ),
            0,
        ),
        ("refuse-gpl-3", make_lock(**{"node_modules/pkg": {"license": "GPL-3.0-or-later"}}), 1),
        ("refuse-gpl-bare", make_lock(**{"node_modules/pkg": {"license": "GPL"}}), 1),
        ("refuse-agpl-3", make_lock(**{"node_modules/pkg": {"license": "AGPL-3.0-only"}}), 1),
        ("refuse-lgpl-2.1", make_lock(**{"node_modules/pkg": {"license": "LGPL-2.1-or-later"}}), 1),
        ("refuse-sspl", make_lock(**{"node_modules/pkg": {"license": "SSPL-1.0"}}), 1),
        ("refuse-unlicensed", make_lock(**{"node_modules/pkg": {"license": "UNLICENSED"}}), 1),
        (
            "refuse-gpl-with-exception",
            make_lock(**{"node_modules/pkg": {"license": "GPL-2.0-only WITH Classpath-exception-2.0"}}),
            1,
        ),
        (
            "accept-spdx-or-with-permissive-branch",
            make_lock(**{"node_modules/pkg": {"license": "(GPL-3.0-only OR MIT)"}}),
            0,
        ),
        (
            "refuse-spdx-or-all-copyleft",
            make_lock(**{"node_modules/pkg": {"license": "(GPL-2.0-only OR AGPL-3.0-only)"}}),
            1,
        ),
        (
            "refuse-spdx-and-with-copyleft",
            make_lock(**{"node_modules/pkg": {"license": "(MIT AND LGPL-3.0-only)"}}),
            1,
        ),
        (
            "refuse-spdx-grouped-or-followed-by-and-copyleft",
            make_lock(**{"node_modules/pkg": {"license": "(MIT OR GPL-3.0-only) AND AGPL-3.0-only"}}),
            1,
        ),
        (
            "accept-spdx-and-permissive",
            make_lock(**{"node_modules/pkg": {"license": "(MIT AND Zlib)"}}),
            0,
        ),
        (
            "refuse-blocknote-scope-direct",
            make_lock(**{"node_modules/@blocknote/core": {"license": "MIT"}}),
            1,
        ),
        (
            "refuse-blocknote-scope-nested",
            make_lock(**{"node_modules/dep/node_modules/@blocknote/react": {"license": "Apache-2.0"}}),
            1,
        ),
        ("refuse-undeclared-license", make_lock(**{"node_modules/mystery": {"version": "1.0.0"}}), 1),
        (
            "accept-legacy-licenses-array",
            make_lock(**{"node_modules/legacy": {"licenses": [{"type": "MIT"}, {"type": "GPL-2.0"}]}}),
            0,
        ),
        (
            "accept-workspace-link-and-local-workspace",
            make_lock(
                **{
                    "apps/web": {"license": "Apache-2.0"},
                    "apps/server": {"license": "AGPL-3.0-or-later"},
                    "node_modules/@kodera/web": {"link": True},
                }
            ),
            0,
        ),
    ]

    failures = 0
    with tempfile.TemporaryDirectory() as folder:
        for label, content, expected in cases:
            path = Path(folder) / "package-lock.json"
            path.write_text(json.dumps(content), encoding="utf-8")
            got = check(path, quiet_errors=True)
            if got != expected:
                failures += 1
                print(
                    f"check-licenses selftest: {label}: expected {expected}, got {got}",
                    file=sys.stderr,
                )
    if failures:
        return 1
    print(f"check-licenses selftest: {len(cases)} cases passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "package-lock.json",
    )
    parser.add_argument("--selftest", action="store_true")
    arguments = parser.parse_args()
    if arguments.selftest:
        return selftest()
    return check(arguments.lock)


if __name__ == "__main__":
    sys.exit(main())

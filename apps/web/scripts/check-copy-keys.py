#!/usr/bin/env python3
"""Check the message catalogues against the specifications.

Three checks, all of which a pull request must pass:

1.  **Parity** — every key in `copy/fr.md` exists in `copy/en.md` and the other way round.
2.  **No duplicates** — a key is defined exactly once per catalogue.
3.  **Referenced keys exist** — every `console.<area>.<screen>.<key>` named in any specification
    under `docs/specs/` is defined in both catalogues.

The reverse of check 3 is deliberately *not* an error: the catalogues carry strings for states a
specification describes in prose ("the field errors inline") without naming the key, and
tightening that would push spec authors to pad tables. Unreferenced keys are reported as a count
only.

Usage: python3 scripts/check-copy-keys.py
Exit code 0 when everything passes, 1 otherwise.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPECS = ROOT / "docs" / "specs"
CATALOGUES = {"fr": SPECS / "copy" / "fr.md", "en": SPECS / "copy" / "en.md"}

# A definition is a table row whose first cell is the key in backticks.
DEFINITION = re.compile(r"^\|\s*`(console\.[a-z0-9_.\-]+)`\s*\|")
# A reference is the key in backticks anywhere in a specification.
REFERENCE = re.compile(r"`(console\.[a-z0-9_.\-]+)`")
# Key shape: console.<area>.<screen>.<key>, the screen being `_` for area-wide strings.
# `common` is the one area with no screens, so its keys are console.common.<key>.
SHAPE = re.compile(r"^console\.(common\.[a-z0-9\-]+|[a-z]+\.[a-z0-9\-_]+\.[a-z0-9\-]+)$")


def definitions(path: pathlib.Path) -> tuple[set[str], list[str]]:
    keys: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = DEFINITION.match(line)
        if match:
            keys.append(match.group(1))
    duplicates = sorted({k for k in keys if keys.count(k) > 1})
    return set(keys), duplicates


def main() -> int:
    problems: list[str] = []

    catalogue: dict[str, set[str]] = {}
    for lang, path in CATALOGUES.items():
        keys, duplicates = definitions(path)
        catalogue[lang] = keys
        for key in duplicates:
            problems.append(f"{path.name}: `{key}` is defined more than once")
        for key in sorted(keys):
            if not SHAPE.match(key):
                problems.append(f"{path.name}: `{key}` does not match console.<area>.<screen>.<key>")

    only_fr = sorted(catalogue["fr"] - catalogue["en"])
    only_en = sorted(catalogue["en"] - catalogue["fr"])
    for key in only_fr:
        problems.append(f"parity: `{key}` is in fr.md and missing from en.md")
    for key in only_en:
        problems.append(f"parity: `{key}` is in en.md and missing from fr.md")

    referenced: dict[str, set[str]] = {}
    for spec in sorted(SPECS.glob("*.md")):
        for key in REFERENCE.findall(spec.read_text(encoding="utf-8")):
            referenced.setdefault(key, set()).add(spec.name)

    for key in sorted(referenced):
        for lang in ("fr", "en"):
            if key not in catalogue[lang]:
                where = ", ".join(sorted(referenced[key]))
                problems.append(f"missing: `{key}` is used in {where} and absent from {lang}.md")

    defined = catalogue["fr"] | catalogue["en"]
    unreferenced = defined - set(referenced)

    print(f"catalogue: {len(catalogue['fr'])} keys in fr.md, {len(catalogue['en'])} in en.md")
    print(f"specifications: {len(referenced)} distinct keys referenced")
    print(f"defined but not named in a specification: {len(unreferenced)} (not an error)")

    if problems:
        print()
        for problem in problems:
            print(f"FAIL {problem}")
        print(f"\n{len(problems)} problem(s).")
        return 1

    print("\nOK — parity holds, no duplicates, every referenced key exists in both catalogues.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Refuse a committed .env file and a GitHub Action that is not pinned to a commit.

Every `uses:` of a workflow or composite action names either a commit (`owner/repo@<40 hex>`)
or a reusable workflow or action of this repository (`./path`), which runs at the caller's own
commit and so needs no pin. A tag or a branch is refused: it can be moved under the workflow.
A tracked file whose name starts with `.env` is refused too, except `.env.example`.

    python3 scripts/ci/check-workflow-pins.py [--root DIR]
    python3 scripts/ci/check-workflow-pins.py --selftest
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PINNED = re.compile(r"uses:\s+[^\s@#]+@[0-9a-f]{40}(?:\s|$)")
LOCAL = re.compile(r"uses:\s+\./[^\s@#]+(?:\s|$)")


def tracked(root: Path) -> list[str]:
    listing = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        check=True,
    )
    return [name for name in listing.stdout.decode().split("\0") if name]


def workflow_files(root: Path) -> list[Path]:
    files = sorted((root / ".github/workflows").glob("*.y*ml"))
    if (root / ".github/actions").exists():
        files += sorted((root / ".github/actions").rglob("*.y*ml"))
    return files


def failures(root: Path) -> list[str]:
    found = [
        f"Forbidden .env file tracked: {name}"
        for name in tracked(root)
        if Path(name).name.startswith(".env") and Path(name).name != ".env.example"
    ]
    for workflow in workflow_files(root):
        for lineno, line in enumerate(workflow.read_text("utf-8").splitlines(), 1):
            code = line.split("#", 1)[0].strip()
            if code.startswith("- "):
                code = code[2:].lstrip()
            if not code.startswith("uses:"):
                continue
            if not (PINNED.match(code) or LOCAL.match(code)):
                found.append(
                    f"Unpinned GitHub Action in {workflow.relative_to(root)}:{lineno}: {line.strip()}"
                )
    return found


def check(root: Path) -> int:
    found = failures(root)
    for failure in found:
        print(f"[FAIL] {failure}", file=sys.stderr)
    if found:
        return 1
    print("All workflows SHA-pinned or local, and zero .env files tracked.")
    return 0


SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"
CLEAN = f"""jobs:
  build:
    steps:
      - uses: actions/checkout@{SHA} # v7.0.1
  call:
    uses: ./.github/workflows/other.yml
"""
CASES = {
    # name: (workflow text, extra tracked file or None, expected marker or None for clean)
    "clean": (CLEAN, None, None),
    "tag pin": (CLEAN.replace(f"@{SHA}", "@v7"), None, "Unpinned GitHub Action"),
    "branch pin": (CLEAN.replace(f"@{SHA}", "@main"), None, "Unpinned GitHub Action"),
    "short sha": (
        CLEAN.replace(f"@{SHA}", f"@{SHA[:12]}"),
        None,
        "Unpinned GitHub Action",
    ),
    "sha with suffix": (
        CLEAN.replace(f"@{SHA}", f"@{SHA}x"),
        None,
        "Unpinned GitHub Action",
    ),
    "no ref": (CLEAN.replace(f"@{SHA}", ""), None, "Unpinned GitHub Action"),
    "local with ref": (
        CLEAN.replace("other.yml", "other.yml@main"),
        None,
        "Unpinned GitHub Action",
    ),
    "remote reusable workflow by tag": (
        CLEAN.replace(
            "./.github/workflows/other.yml", "acme/ci/.github/workflows/x.yml@v1"
        ),
        None,
        "Unpinned GitHub Action",
    ),
    "tracked .env": (CLEAN, ".env", "Forbidden .env file tracked"),
    "tracked .env.staging": (
        CLEAN,
        "deploy/.env.staging",
        "Forbidden .env file tracked",
    ),
    "tracked .env.example": (CLEAN, "deploy/.env.example", None),
}


def selftest() -> int:
    caught = 0
    for name, (text, extra, marker) in CASES.items():
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/workflows/ci.yml").write_text(text)
            if extra:
                (root / extra).parent.mkdir(parents=True, exist_ok=True)
                (root / extra).write_text("K=v\n")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "-A", "-f"], check=True)
            found = failures(root)
            if marker is None:
                if found:
                    print(
                        f"selftest FAIL [{name}]: expected clean, got {found}",
                        file=sys.stderr,
                    )
                    return 1
            else:
                if len(found) != 1 or marker not in found[0]:
                    print(
                        f"selftest FAIL [{name}]: expected one '{marker}', got {found}",
                        file=sys.stderr,
                    )
                    return 1
                caught += 1
            print(f"  ok  {name}")
    print(
        f"check-workflow-pins selftest: {len(CASES)} cases, {caught} refusals each by its own message"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root", default=Path(__file__).resolve().parents[2], type=Path
    )
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    return selftest() if args.selftest else check(args.root)


if __name__ == "__main__":
    sys.exit(main())

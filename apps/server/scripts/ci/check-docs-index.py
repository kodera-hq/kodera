#!/usr/bin/env python3
"""Fail when docs/INDEX.md and the files under docs/ disagree.

The index promises that every document under docs/ has a row and that every
row points at a file. Until this check existed the promise was prose: nine
documents had landed without a row and one row named a file by the wrong
case. Three defects are reported, each the kind that rots quietly:

- an orphan: a file under docs/ with no row;
- a phantom: a row whose path does not exist, unless the row is reserved;
- a stale reservation: a reserved row whose path now exists.

A row is reserved when it carries the annotation "Written in parallel", the
one exception docs/INDEX.md states for itself. Rows are read from every table
whose first header cell is `Doc` or `File`; a row in such a table that names
no path at all is an error rather than a skip, because a row the scanner
cannot read is a row it would otherwise report as satisfied.

Parsed with a small scanner rather than a Markdown library so the check has no
dependency beyond the interpreter already present on the runner.
"""

import argparse
import os
import re
import sys

INDEX = os.path.join("docs", "INDEX.md")
RESERVED = "Written in parallel"
DOCUMENT_TABLES = {"Doc", "File"}

LINK = re.compile(r"\]\(([^)]+)\)")
CODE = re.compile(r"`([^`]+)`")
SEPARATOR = re.compile(r"^\|(?:\s*:?-+:?\s*\|)+\s*$")


def cells(line):
    """The stripped cells of a table row."""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse(text):
    """Yield (line number, target or None, reserved) for every document row."""
    lines = text.splitlines()
    in_document_table = False
    for number, line in enumerate(lines, start=1):
        if not line.startswith("|"):
            in_document_table = False
            continue
        following = lines[number] if number < len(lines) else ""
        if SEPARATOR.match(following):
            in_document_table = cells(line)[0] in DOCUMENT_TABLES
            continue
        if SEPARATOR.match(line) or not in_document_table:
            continue
        first = cells(line)[0]
        match = LINK.search(first) or CODE.search(first)
        yield number, match.group(1) if match else None, RESERVED in line


def documents(docs_dir):
    """Every file under docs/, as a path relative to docs/. Dotfiles are not documents."""
    found = set()
    for base, dirs, files in os.walk(docs_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in files:
            if name.startswith("."):
                continue
            found.add(os.path.relpath(os.path.join(base, name), docs_dir))
    return found


def check(root):
    """Return the list of problems; empty means the index and the tree agree."""
    index = os.path.join(root, INDEX)
    docs_dir = os.path.normpath(os.path.join(root, "docs"))
    if not os.path.isfile(index):
        return [f"::error file={INDEX}::the index does not exist"]

    text = open(index, encoding="utf-8").read()
    problems = []
    listed = set()
    row_count = 0

    for number, target, reserved in parse(text):
        row_count += 1
        where = f"::error file={INDEX},line={number}::"
        if target is None:
            problems.append(
                f"{where}this row names no path; a row the check cannot read is not a row"
            )
            continue
        path = os.path.normpath(os.path.join(docs_dir, target))
        shown = os.path.relpath(path, root)
        exists = os.path.exists(path)
        if reserved and exists:
            problems.append(
                f"{where}`{shown}` exists, so the row is no longer reserved: drop the annotation"
            )
        elif not reserved and not exists:
            problems.append(f"{where}`{shown}` does not exist and the row is not reserved")
        if path.startswith(docs_dir + os.sep):
            listed.add(os.path.relpath(path, docs_dir))

    for document in sorted(documents(docs_dir) - listed):
        problems.append(f"::error file=docs/{document}::no row in {INDEX}")

    if not problems:
        print(
            f"{INDEX}: {row_count} rows, {len(listed)} documents under docs/, "
            "every row resolves and every document has a row"
        )
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".", help="repository root (default: current directory)")
    args = parser.parse_args()
    problems = check(args.root)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check that every acceptance test named in the screen specifications exists,
verbatim, as a Playwright test in the end-to-end suite.

The *screen* specifications — `docs/specs/NN-name.md` — close with a numbered "Acceptance
tests" section (section 12 — see `docs/specs/README.md`, "Acceptance-test convention").
Not every document under `docs/specs/` is one: the recovery and bridge notes use a
"Runnable acceptance" section instead, which names the commands to run rather than test
names, and yields nothing here. Measured on this repository: nine numbered screen
specifications carry section 12, and eleven other documents carry none, contributing no
names at all. Those eleven are reported as 0/0, which is the honest reading of a document
this gate has nothing to say about — it is not evidence that their behaviour is covered.

Every entry in a section 12 carries its Playwright test name on its own line, wrapped in a
single pair of backticks:

    `<area>/<screen>: <observable behaviour, present tense, from the user's side>`

This script extracts those names and uses the installed TypeScript compiler to parse
static literal test declarations in `tests/e2e/**/*.spec.ts`. It reports source-name
coverage, not execution or scenario success. Node and the installed dev dependencies
are required; parser errors fail the run. Comments, strings and inactive declarations
do not count; computed titles are reported as unresolved.

A gate that always reports success is worse than no gate, so this script refuses to pass
quietly in two situations:

*   a name that is *supposed* to be a test name — a whole line wrapped in a single pair
    of backticks, inside section 12 — but does not match the `<area>/<screen>: <text>`
    shape is reported as malformed and always fails the run, `--require-all` or not;
*   the specifications directory is present but yields suspiciously few files or names,
    which is what a broken heading match or a broken backtick pattern looks like: still
    green, silently checking nothing. The floors (`--min-spec-files`, `--min-names`)
    default to this repository's own scale and can be lowered for a smaller fixture.

A missing name — present in a spec, absent from the suite — is always reported. It fails
the run for a specification listed in `scripts/spec-gate.json` (`{"requireAll": [
"05-invoices.md", ...]}`: the specs whose screen has merged, so spec and suite are
expected to agree from then on), or for every specification when `--require-all` is
passed. The specifications land before the tests that satisfy them do, so a spec is added
to that list in the pull request that lands its screen, not before. A listed file that
does not exist under the specs directory fails the run too — a typo there would otherwise
gate nothing, quietly — and so does a list file that cannot be read.

When `docs/specs/` is absent, report-only mode with a valid empty allowlist skips
loudly. A nonempty allowlist or --require-all fails instead; invalid allowlists
always fail. Every enforced spec must yield at least one valid acceptance-test name.

Usage: python3 scripts/check-spec-tests.py [--require-all] [--allowlist FILE]
                                            [--specs-dir DIR] [--e2e-dir DIR]
                                            [--min-spec-files N] [--min-names N]
Exit code 0 normally (including "nothing to check yet" and "some names are missing" in a
specification that is neither listed nor covered by --require-all). Exit code 1 when a
name is malformed, when the specifications directory looks suspiciously thin, when the
allowlist names a spec file that does not exist or cannot be read itself, or when a named
test is missing from a specification the run gates — listed, or all under --require-all.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

DEFAULT_SPECS_DIR = ROOT / "docs" / "specs"
DEFAULT_E2E_DIR = ROOT / "tests" / "e2e"
DEFAULT_ALLOWLIST = ROOT / "scripts" / "spec-gate.json"
DEFAULT_MIN_SPEC_FILES = 5
DEFAULT_MIN_NAMES = 80

SECTION_HEADING = re.compile(r"^##\s+(\d+)\.")
# A candidate: the entire (stripped) line is one pair of backticks. This is the only
# shape section 12 uses for a test name — see the whole-line-backtick scan this pattern
# was checked against in docs/specs/*.md — so anything here that is not a well-formed
# name is a mistake in the spec, not an unrelated bit of inline code.
CANDIDATE_LINE = re.compile(r"^[ \t]*`([^`]+)`[ \t]*$")
NAME_SHAPE = re.compile(r"^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*: \S(?:.*\S)?$")


def section_12(text: str) -> str:
    """Return the body of the "12. Acceptance tests" heading, up to the next `## `
    heading or the end of the file. Empty string if there is no section 12."""
    lines = text.splitlines()
    start: int | None = None
    end = len(lines)
    for i, line in enumerate(lines):
        if start is None:
            match = SECTION_HEADING.match(line)
            if match and match.group(1) == "12":
                start = i + 1
        elif line.startswith("## "):
            end = i
            break
    return "\n".join(lines[start:end]) if start is not None else ""


def names_in_spec(path: pathlib.Path) -> tuple[list[str], list[str]]:
    """Return (valid test names, malformed candidate lines) for one spec file."""
    valid: list[str] = []
    malformed: list[str] = []
    for line in section_12(path.read_text(encoding="utf-8")).splitlines():
        match = CANDIDATE_LINE.match(line)
        if not match:
            continue
        candidate = match.group(1)
        if NAME_SHAPE.match(candidate):
            valid.append(candidate)
        else:
            malformed.append(candidate)
    return valid, malformed


def test_names_in_suite(e2e_dir: pathlib.Path) -> set[str]:
    """Static declarations only; neither source coverage nor parsing executes tests."""
    paths = sorted(str(path) for path in e2e_dir.rglob("*.spec.ts")) if e2e_dir.is_dir() else []
    result = subprocess.run(
        ["node", str(ROOT / "scripts" / "spec-test-names.mjs")],
        input=json.dumps(paths), text=True, capture_output=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise ValueError("source scan failed: " + result.stderr.strip())
    data = json.loads(result.stdout)
    for notice in data["notices"]:
        print("NOTICE " + notice)
    print("Static source coverage only; test execution and scenario success are not verified.")
    return set(data["names"])


def unique_json_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate allowlist key")
        result[key] = value
    return result


def gated_specs(path: pathlib.Path) -> tuple[set[str], str | None]:
    """Return (spec file names whose misses fail the run, error). The file is
    `{"requireAll": ["<spec>.md", ...]}` and nothing else; anything it is not is an error
    rather than an empty list, so the gate cannot be switched off by breaking its list."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_json_keys)
    except (OSError, ValueError) as error:
        return set(), f"{path}: cannot read the allowlist ({error})"
    names = data.get("requireAll") if isinstance(data, dict) and set(data) == {"requireAll"} else None
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        return set(), f'{path}: expected {{"requireAll": ["<spec>.md", ...]}} allowlist'
    return set(names), None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-all", action="store_true")
    parser.add_argument("--allowlist", type=pathlib.Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument("--specs-dir", type=pathlib.Path, default=DEFAULT_SPECS_DIR)
    parser.add_argument("--e2e-dir", type=pathlib.Path, default=DEFAULT_E2E_DIR)
    parser.add_argument("--min-spec-files", type=int, default=DEFAULT_MIN_SPEC_FILES)
    parser.add_argument("--min-names", type=int, default=DEFAULT_MIN_NAMES)
    args = parser.parse_args(argv)

    gated, allowlist_error = gated_specs(args.allowlist)
    if allowlist_error is not None:
        print(f"FAIL {allowlist_error}")
        return 1
    if not args.specs_dir.is_dir():
        if gated or args.require_all:
            print("FAIL enforced specifications directory is absent")
            return 1
        print(f"{args.specs_dir} does not exist — nothing to check yet, skipping.")
        return 0

    spec_files = sorted(p for p in args.specs_dir.glob("*.md") if p.name != "README.md")
    try:
        suite_names = test_names_in_suite(args.e2e_dir)
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"FAIL source scan failed: {error}")
        return 1

    problems: list[str] = []
    for name in sorted(gated - {spec.name for spec in spec_files}):
        problems.append(f"{args.allowlist.name} lists {name}, which is not under {args.specs_dir}")

    total_names = 0
    total_present = 0

    for spec in spec_files:
        valid, malformed = names_in_spec(spec)
        for bad in malformed:
            problems.append(f"{spec.name}: malformed acceptance-test name `{bad}`")

        present = [name for name in valid if name in suite_names]
        missing = [name for name in valid if name not in suite_names]
        total_names += len(valid)
        total_present += len(present)

        gate = "--require-all" if args.require_all else (
            f"listed in {args.allowlist.name}" if spec.name in gated else None
        )
        print(f"{spec.name}: {len(present)}/{len(valid)}" + (f" (gated: {gate})" if gate else ""))
        for name in missing:
            print(f"  missing: {name}")
        if gate and not valid:
            problems.append(f"{spec.name}: gated specification has no acceptance-test names")
        if gate and missing:
            problems.append(
                f"{spec.name}: {len(missing)} acceptance-test name(s) have no matching "
                f"Playwright test and the spec is gated ({gate})"
            )

    print(f"\noverall: {total_present}/{total_names}")
    print("gated: " + (", ".join(sorted(gated)) if gated else "none") + (
        " (--require-all: every spec)" if args.require_all else ""
    ))

    if len(spec_files) < args.min_spec_files or total_names < args.min_names:
        problems.append(
            f"only {len(spec_files)} spec file(s) yielding {total_names} name(s) were "
            f"found under {args.specs_dir} — expected at least {args.min_spec_files} "
            f"file(s) and {args.min_names} name(s); refusing to pass vacuously"
        )

    if problems:
        print()
        for problem in problems:
            print(f"FAIL {problem}")
        print(f"\n{len(problems)} problem(s).")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

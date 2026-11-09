#!/usr/bin/env python3
"""Fail CI when a dependency advisory sits in this tree unaccounted for.

docs/security/SECURE_SDLC.md has said since its first revision that a known
advisory blocks a pull request, and no job here ran an advisory check of any
kind. This is that check, for the two lockfiles this repository commits, and for what one of them
cannot show:

- ``uv.lock``, every package in it, the ``dev`` group included. A development
  tool runs in CI with the repository's token and on every engineer's machine,
  so a tier that quietly does not block is a green control asserting less than
  a reader believes. The lock is exported with ``uv export --frozen`` and
  audited by a pinned ``pip-audit`` that resolves nothing and installs nothing.
- ``contracts/lint/package-lock.json``, read by ``npm audit --package-lock-only``
  with dev dependencies forced on: the linter is a dev dependency, and it is
  the only Node tree here.
- the libraries compiled into that linter. From 2.x, ``@redocly/cli`` is one
  self-contained bundle that declares no npm dependency, so the lockfile holds
  one package and the audit above, like Dependabot, sees only the CLI. The
  name@version pairs the installed package lists in its THIRD_PARTY_NOTICES
  are written into throwaway lockfiles and audited by the same ``npm audit``,
  against the same registry endpoint, with the same rules. A missing package,
  a missing or unreadable notices file, a list that comes out empty or only
  partly read, or an audit that covered fewer libraries than it was given
  refuses: the bundled half could not look, which is not the same as clean.
  THIRD_PARTY_NOTICES lists third-party libraries only: Redocly's own packages
  compiled into the bundle (``@redocly/openapi-core``, ``@redocly/respect-core``
  and the like) are not in it, and are covered only by advisories filed
  against ``@redocly/cli`` itself, which the lockfile audit sees. From 2.71.0
  the notices also omit the libraries inside Redoc 3's prebuilt bundles, which
  the CLI compiles in. DOMPurify, the one of them with excused advisories, is
  read from its licence banner in the shipped JavaScript and audited with the
  rest; a bundle that still names it without a readable banner refuses. The
  others carry no inventory and are not audited.

It applies the rules of the console's gate (kodera-web
``scripts/check-audit.mjs``) to both reports, with one allowlist,
``advisory-allowlist.json`` at the repository root:

- An advisory that blocks and has no entry fails.
- An entry is BOUND to the finding it excuses. If a bound field moves, the
  entry no longer describes the finding and the gate fails rather than
  inheriting the old reason. An entry with no written reason fails.
- An entry naming an advisory no longer reported fails, so a stale excuse
  cannot sit in the file waiting to cover something nobody decided.
- npm reports a severity. ``moderate`` and above blocks; below it an advisory
  is printed and does not block, and an entry for one fails, because it is to
  be deleted rather than re-bound.
- pip-audit reports NO severity: its JSON carries an identifier, the installed
  version, the fixed versions and aliases, nothing else. A threshold cannot be
  applied to a number that is not there, and reading the absence as "low"
  would be the gate deciding something nobody decided. So every Python
  advisory blocks, and a Python entry is bound to what the report does carry:
  the package, the locked version, and the fixed versions.

Parse first, then decide. Both tools exit non-zero whenever they find
anything, and also when they could not look, so a branch on the exit code
reads "there is an advisory" and "the index was unreachable" as one event.
Every report is parsed before anything is judged, an unreadable or empty one
refuses loudly, and the exit code is read only AFTER the parse, to refuse a
failed run that reports nothing. ``check-advisories.selftest.sh`` proves each
refusal by its message and its exit status.

The tree audited is the tree you are standing in, and so is the allowlist that
excuses it. There is no option re-pointing the allowlist: a knob that re-points
it is a knob that turns this gate off. ``--pip-audit`` names the binary only,
because CI installs it into its own environment, apart from the tree it audits.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

THRESHOLD = "moderate"
ORDER = ["info", "low", "moderate", "high", "critical"]
BLOCKS_AT = ORDER.index(THRESHOLD)

FILE = "advisory-allowlist.json"
NPM_DIR = Path("contracts") / "lint"

# The fields each ecosystem's entry is bound by, beyond `ecosystem`,
# `advisory` and `reason`. A field the report cannot carry is refused rather
# than ignored: a `severity` on a Python entry would read as a decision that
# nothing ever checks.
BOUND = {
    "npm": ("package", "severity", "range"),
    "pypi": ("package", "version", "fix_versions"),
}

GHSA = re.compile(r"/advisories/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})", re.IGNORECASE)
# One line of `uv export --no-hashes --no-annotate --no-header`: a pinned
# requirement, optionally with extras and an environment marker.
EXPORT_LINE = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==(?P<version>[^\s;]+)\s*(?:;.*)?$"
)


def refuse(message, detail=None):
    """Stop, having established nothing. Distinct from a judged failure."""
    if detail:
        print(str(detail)[:4000], file=sys.stderr)
    print(f"check-advisories: {message}", file=sys.stderr)
    sys.exit(1)


def normalise(name):
    """PEP 503: the name pip-audit, uv and PyPI all compare by."""
    return re.sub(r"[-_.]+", "-", name).lower()


def run(argv, cwd, what):
    try:
        return subprocess.run(  # noqa: S603 - fixed argument vectors, no shell
            argv, cwd=cwd, capture_output=True, text=True, check=False
        )
    except OSError as exc:
        refuse(
            f"could not run {what} at all ({exc}). This job cannot claim a tree is clean "
            "when it never read it."
        )


def parse_json(proc, what):
    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        refuse(
            f"{what} produced no readable JSON, so the advisories in this tree cannot be "
            "established. Refusing rather than assuming the tree is clean.",
            "\n".join(s for s in (proc.stdout, proc.stderr) if s),
        )


# --- Python: uv.lock --------------------------------------------------------


def locked_packages(root):
    """Every package uv.lock pins, except the project itself."""
    try:
        lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        refuse(f"uv.lock is not readable ({exc}), so what it pins cannot be established.")
    packages = {}
    for package in lock.get("package", []):
        source = package.get("source", {})
        if "virtual" in source or "editable" in source:
            continue
        name, version = normalise(package.get("name", "")), package.get("version")
        if not name or not isinstance(version, str):
            refuse(f"uv.lock carries a package with no name or version: {package!r:.200}")
        if name in packages:
            # pip-audit refuses two pins of one name in one requirements file,
            # and a lock forked by environment markers produces exactly that.
            # Audit each fork separately when that day comes.
            refuse(
                f"uv.lock pins `{name}` more than once, a resolution forked by environment "
                "markers. One requirements file cannot carry both, so this gate cannot "
                "audit the lock as it stands."
            )
        packages[name] = version
    if not packages:
        refuse("uv.lock pins no package at all. An empty lock is not an audited one.")
    return packages


def exported_packages(root):
    """`uv export` of every group and extra, read line by line."""
    proc = run(
        [
            "uv",
            "export",
            "--frozen",
            "--all-groups",
            "--all-extras",
            "--no-emit-project",
            "--no-hashes",
            "--no-annotate",
            "--no-header",
            "--format",
            "requirements-txt",
        ],
        root,
        "uv export",
    )
    if proc.returncode != 0:
        refuse(
            f"uv export exited {proc.returncode}, so the packages uv.lock pins cannot be "
            "listed for the audit.",
            proc.stderr or proc.stdout,
        )
    packages = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = EXPORT_LINE.match(line)
        if not match:
            # Not skipped: a line this gate cannot read is a package it would
            # otherwise pass over unaudited.
            refuse(
                f"uv export printed a line this gate cannot read as a pinned requirement: "
                f"`{line[:200]}`. The export format has changed; read it before trusting "
                "this gate again."
            )
        packages[normalise(match["name"])] = match["version"]
    return packages


def audit_python(root, pip_audit):
    locked = locked_packages(root)
    exported = exported_packages(root)

    # The decision this gate implements is that a dev-only finding blocks. An
    # export that left the dev group out would satisfy it vacuously, so the
    # export is compared with the lock it came from, package by package.
    missing = sorted(set(locked) - set(exported))
    if missing:
        refuse(
            f"uv export did not list {len(missing)} package(s) uv.lock pins "
            f"({', '.join(missing[:10])}). An audit of part of the lock proves nothing "
            "about the rest of it."
        )
    stray = sorted(set(exported) - set(locked))
    moved = sorted(n for n in exported if n in locked and exported[n] != locked[n])
    if stray or moved:
        refuse(
            f"uv export and uv.lock disagree (not in the lock: {', '.join(stray) or 'none'}; "
            f"another version: {', '.join(moved) or 'none'})."
        )

    # Every pin, with no environment marker. pip-audit evaluates a marker
    # against the runner and silently drops a package it does not match, so a
    # Windows-only or older-Python pin would never be looked at.
    with tempfile.TemporaryDirectory() as scratch:
        requirements = Path(scratch) / "requirements.txt"
        requirements.write_text(
            "".join(f"{name}=={version}\n" for name, version in sorted(exported.items())),
            encoding="utf-8",
        )
        proc = run(
            [
                pip_audit,
                "--requirement",
                str(requirements),
                "--no-deps",
                "--disable-pip",
                "--vulnerability-service",
                "osv",
                "--format",
                "json",
                "--aliases",
                "on",
                "--desc",
                "off",
                "--progress-spinner",
                "off",
            ],
            root,
            "pip-audit",
        )
    report = parse_json(proc, "pip-audit")
    dependencies = report.get("dependencies") if isinstance(report, dict) else None
    if not isinstance(dependencies, list):
        refuse(
            "pip-audit returned JSON that carries no `dependencies` list. An absent list is "
            "not an empty one.",
            proc.stdout,
        )
    if not dependencies:
        refuse(
            f"pip-audit audited no package at all, out of {len(exported)} exported from "
            "uv.lock. An empty report is not a clean one.",
            proc.stderr,
        )

    findings = []
    audited = {}
    for dep in dependencies:
        if not isinstance(dep, dict) or not isinstance(dep.get("name"), str):
            refuse(f"pip-audit reports a dependency this gate cannot read: {dep!r:.200}")
        name = normalise(dep["name"])
        if "skip_reason" in dep:
            refuse(
                f"pip-audit skipped `{name}` ({dep['skip_reason']}). A package it could not "
                "audit is not a package with no advisory."
            )
        version, vulns = dep.get("version"), dep.get("vulns")
        if not isinstance(version, str) or not isinstance(vulns, list):
            refuse(f"pip-audit reports `{name}` with no version or no `vulns` list.")
        audited[name] = version
        for vuln in vulns:
            ident = vuln.get("id") if isinstance(vuln, dict) else None
            fixes = vuln.get("fix_versions") if isinstance(vuln, dict) else None
            if not isinstance(ident, str) or not ident.strip():
                refuse(
                    f"pip-audit reports an advisory against `{name}` carrying no `id`, so it "
                    f"cannot be bound to an {FILE} entry.",
                    json.dumps(vuln),
                )
            if not isinstance(fixes, list) or not all(isinstance(f, str) for f in fixes):
                refuse(f"pip-audit reports advisory {ident} with no `fix_versions` list.")
            findings.append(
                {
                    "ecosystem": "pypi",
                    "id": ident,
                    "package": name,
                    "version": version,
                    "fix_versions": sorted(fixes),
                    "aliases": sorted(a for a in vuln.get("aliases", []) if isinstance(a, str)),
                    "severity": None,
                }
            )

    unaudited = sorted(n for n in exported if audited.get(n) != exported[n])
    if unaudited:
        refuse(
            f"pip-audit did not report on {len(unaudited)} of the {len(exported)} exported "
            f"package(s) at their locked version ({', '.join(unaudited[:10])})."
        )

    # Read AFTER the parse, never instead of it: a failed run that lists
    # nothing must not pass as an empty one.
    if proc.returncode != 0 and not findings:
        refuse(
            f"pip-audit exited {proc.returncode} over a report that lists no advisory at "
            "all. The exit code and the report disagree, so neither is evidence this tree "
            "is clean.",
            proc.stderr,
        )
    return findings, f"pip-audit: {len(audited)} packages from uv.lock (dev group included)"


# --- Node: contracts/lint/package-lock.json ---------------------------------


def npm_audit(tree, what, check_coverage):
    """Run `npm audit` in `tree` and read every advisory out of its report.

    `what` names the audit in every refusal, so a reader can tell the lockfile
    audit from the bundled one. `check_coverage(deps)` is handed the report's
    `metadata.dependencies` and refuses when the audit saw less than it should.
    Returns the findings, the dependency counts and the vulnerability counts.
    """
    # `--include=dev` is not a no-op: it overrides an `omit=dev` in an .npmrc
    # or NPM_CONFIG_OMIT, which would drop every dev advisory from the report.
    proc = run(["npm", "audit", "--json", "--package-lock-only", "--include=dev"], tree, what)
    report = parse_json(proc, what)
    if isinstance(report, dict) and report.get("error"):
        error = report["error"]
        summary = error.get("summary") or error.get("code") if isinstance(error, dict) else error
        refuse(
            f"{what} returned an error instead of a report ({summary}). An audit that did "
            "not complete is not an audit that found nothing.",
            proc.stdout,
        )
    metadata = report.get("metadata") if isinstance(report, dict) else None
    counts = metadata.get("vulnerabilities") if isinstance(metadata, dict) else None
    if not isinstance(counts, dict) or not isinstance(counts.get("total"), int):
        refuse(
            f"{what} returned JSON that carries no `metadata.vulnerabilities` counts. An "
            "absent count is not a count of zero.",
            proc.stdout,
        )
    vulnerable = report.get("vulnerabilities")
    if not isinstance(vulnerable, dict):
        refuse(
            f"{what} returned JSON that carries no `vulnerabilities` map, so no advisory "
            "can be read out of it.",
            proc.stdout,
        )
    deps = metadata.get("dependencies", {})
    if not isinstance(deps, dict):
        deps = {}
    check_coverage(deps)

    # The map and the count are two readings of one report. If they disagree,
    # the shape this gate reads is no longer the shape npm writes.
    if len(vulnerable) != counts["total"]:
        refuse(
            f"{what} lists {len(vulnerable)} vulnerable package(s) in `vulnerabilities` "
            f"but counts {counts['total']} in `metadata.vulnerabilities.total`. The report "
            "disagrees with itself, so no verdict can be read out of it.",
            proc.stdout,
        )

    findings = {}
    for key, entry in vulnerable.items():
        # Nothing here is skipped. An entry this gate cannot read is a
        # vulnerable package it would otherwise pass over in silence.
        if not isinstance(entry, dict):
            refuse(
                f"{what} lists `{key}` as vulnerable with an entry that is not an object, "
                "so no advisory can be read out of it. The report shape has changed; read it "
                "before trusting this gate again.",
                json.dumps(entry),
            )
        if not isinstance(entry.get("via"), list) or not entry["via"]:
            refuse(
                f"{what} lists `{key}` as vulnerable but its entry carries no `via` list, so "
                "the advisory behind it cannot be read. The report shape has changed; read it "
                "before trusting this gate again.",
                json.dumps(entry, indent=2),
            )
        for via in entry["via"]:
            # A package vulnerable only through another names it here; the
            # advisory is read from the entry that carries it.
            if isinstance(via, str):
                continue
            if not isinstance(via, dict):
                refuse(
                    f"{what} lists `{key}` as vulnerable through `{via!r:.80}`, which is "
                    "neither a package name nor an advisory."
                )
            url = via.get("url")
            ghsa = GHSA.search(url) if isinstance(url, str) else None
            source = via.get("source")
            ident = ghsa[1] if ghsa else (str(source) if isinstance(source, int) else None)
            name = via.get("name") or entry.get("name")
            if not ident:
                refuse(
                    f"{what} reports an advisory against `{name}` carrying neither a GHSA "
                    f"url nor a numeric `source`, so it cannot be bound to an {FILE} entry.",
                    json.dumps(via, indent=2),
                )
            if via.get("severity") not in ORDER:
                refuse(
                    f"{what} reports advisory {ident} at severity `{via.get('severity')}`, "
                    f"which is not one of {', '.join(ORDER)}."
                )
            if not isinstance(via.get("range"), str):
                refuse(
                    f"{what} reports advisory {ident} with no vulnerable `range`, so an "
                    "allowlist entry has nothing to be bound to."
                )
            findings.setdefault(
                (ident, name),
                {
                    "ecosystem": "npm",
                    "id": ident,
                    "package": name,
                    "severity": via["severity"],
                    "range": via["range"],
                    "aliases": [],
                },
            )

    # Vulnerable packages, and not one advisory among them: every `via` names
    # another package, so the advisories went somewhere this gate does not
    # read. Passing here would print OK over a report listing vulnerabilities.
    if vulnerable and not findings:
        refuse(
            f"{what} lists {len(vulnerable)} vulnerable package(s) and this gate read no "
            "advisory out of any of them. The report shape has changed; read it before "
            "trusting this gate again.",
            proc.stdout,
        )

    if proc.returncode != 0 and not findings and counts["total"] == 0:
        refuse(
            f"{what} exited {proc.returncode} over a report that lists no advisory at all. "
            "The exit code and the report disagree, so neither is evidence this tree is clean.",
            proc.stderr,
        )
    return list(findings.values()), deps, counts


def audit_npm(root):
    tree = root / NPM_DIR
    try:
        manifest = json.loads((tree / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        refuse(f"{NPM_DIR}/package.json is not readable ({exc}).")
    declared = len(manifest.get("dependencies", {})) + len(manifest.get("devDependencies", {}))
    declared_dev = len(manifest.get("devDependencies", {}))

    def check_coverage(deps):
        if declared and not deps.get("total", 0):
            refuse(
                f"npm audit audited no package at all, while {NPM_DIR}/package.json declares "
                f"{declared}. An empty report is not a clean one."
            )
        # The linter is a devDependency: an audit blind to dev saw nothing.
        if declared_dev and not deps.get("dev", 0):
            refuse(
                f"{NPM_DIR}/package.json declares {declared_dev} devDependencies and npm audit "
                "reported 0 development dependencies, so dev was omitted from the audit."
            )

    findings, deps, counts = npm_audit(tree, "npm audit", check_coverage)
    for finding in findings:
        finding["where"] = f"{NPM_DIR}/package-lock.json"
    summary = (
        f"npm audit: {deps.get('total', 0)} packages from {NPM_DIR}/package-lock.json "
        f"({deps.get('dev', '?')} dev), {counts['total']} vulnerable"
    )
    return findings, summary


# --- Node: the libraries bundled inside @redocly/cli ------------------------
#
# From 2.x, @redocly/cli is published as one self-contained bundle that
# declares no npm dependency at all, so the lockfile holds one package and the
# audit above sees only the CLI itself. The libraries compiled into it are
# named, with their versions, in the THIRD_PARTY_NOTICES file the package
# ships; the package carries no more machine-readable list. Those
# name@version pairs are written into a throwaway lockfile and audited by the
# same `npm audit`, against the same registry endpoint, under the same rules
# and the same allowlist. A package that ships two copies of one library at
# two versions cannot sit in one flat lockfile, so each version past the first
# goes into another throwaway lockfile, audited in turn.
#
# The notices are not the whole bundle. From 2.71.0 the CLI compiles in Redoc
# 3's prebuilt bundles (redoc/bundles/redoc.js, and lib/chunks/
# redoc.standalone.js), whose own libraries the notices do not list. One of
# them, DOMPurify, carries advisories this repository has excused by name, and
# dropping it from the notices does not remove it from the code. UNLISTED names
# such a library and the licence banner the minifier keeps for it, which
# carries the version; every version found in the shipped JavaScript joins the
# audited pairs. A bundle that still names the library while no banner can be
# read refuses: the library is there at a version this gate cannot establish.
# Only a bundle that no longer mentions it at all has removed it. The rest of
# Redoc's compiled-in libraries carry no inventory, and this list does not
# pretend to be one.
UNLISTED = {
    "dompurify": (
        re.compile(r"@license DOMPurify (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.+-])"),
        re.compile(r"DOMPurify"),
    ),
}

LINTER = "@redocly/cli"
NOTICES_HEADER = f"Third-party software bundled in {LINTER}"
SEPARATOR = re.compile(r"^=+$")
NOTICE_PACKAGE = re.compile(
    r"^  (?P<name>(?:@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+)"
    r"@(?P<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)"
    r"(?: — .*)?$"
)


def bundled_packages(root):
    """The name@version pairs the installed linter's THIRD_PARTY_NOTICES names."""
    tree = root / NPM_DIR
    try:
        lock = json.loads((tree / "package-lock.json").read_text(encoding="utf-8"))
        pinned = lock["packages"][f"node_modules/{LINTER}"]["version"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        refuse(
            f"{NPM_DIR}/package-lock.json does not say which {LINTER} it pins ({exc!r}), so "
            "the libraries bundled in it cannot be established."
        )
    package = tree / "node_modules" / LINTER
    try:
        installed = json.loads((package / "package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        refuse(
            f"{LINTER} is not installed in {NPM_DIR} (run `npm ci --ignore-scripts` there), "
            "so the libraries bundled in it cannot be listed. The bundled half of this "
            "audit could not look; that is not the same as finding nothing."
        )
    if installed != pinned:
        refuse(
            f"{NPM_DIR}/node_modules holds {LINTER} {installed} but the lockfile pins "
            f"{pinned}. The notices read would describe a different bundle; run "
            "`npm ci --ignore-scripts` there."
        )
    try:
        lines = (package / "THIRD_PARTY_NOTICES").read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        refuse(
            f"{LINTER} {installed} ships no readable THIRD_PARTY_NOTICES ({exc.strerror}), "
            "so the libraries bundled in it cannot be listed. If this release stopped "
            "bundling, the lockfile audit covers it again; read the package and change "
            "this gate deliberately."
        )
    head = next((line for line in lines if line.strip()), "")
    if head.strip() != NOTICES_HEADER:
        refuse(
            f"{LINTER} {installed}'s THIRD_PARTY_NOTICES does not open with "
            f"`{NOTICES_HEADER}` (it opens with `{head[:80]}`). The file's format has "
            "changed; read it before trusting this gate again."
        )

    pairs, sections, blocks, block = [], 0, 0, None
    for line in lines:
        if SEPARATOR.match(line):
            sections += 1
        elif line == "Packages:":
            blocks += 1
            block = []
        elif block is not None:
            if not line.strip():
                if not block:
                    refuse(
                        f"{LINTER} {installed}'s THIRD_PARTY_NOTICES has a `Packages:` block "
                        "naming no package. The file's format has changed; read it before "
                        "trusting this gate again."
                    )
                pairs.extend(block)
                block = None
                continue
            match = NOTICE_PACKAGE.match(line)
            if not match:
                # Not skipped: a line this gate cannot read is a bundled
                # library it would otherwise pass over unaudited.
                refuse(
                    f"{LINTER} {installed}'s THIRD_PARTY_NOTICES lists a line this gate "
                    f"cannot read as name@version: `{line.strip()[:120]}`. The file's format "
                    "has changed; read it before trusting this gate again."
                )
            block.append((match["name"], match["version"]))
    if block:
        pairs.extend(block)
    # Every section of the file names its packages under one `Packages:`
    # heading. A section without one is a section whose libraries this reader
    # walked past.
    if not pairs or blocks != sections:
        refuse(
            f"{LINTER} {installed}'s THIRD_PARTY_NOTICES yielded {len(pairs)} bundled "
            f"package(s) from {blocks} `Packages:` block(s) in {sections} section(s). An "
            "empty or partly read list is not a clean one."
        )
    unlisted = unlisted_packages(package, installed, set(pairs))
    return installed, sorted(set(pairs) | set(unlisted)), unlisted


def unlisted_packages(package, installed, listed):
    """The UNLISTED name@version pairs the shipped JavaScript carries and the notices omit."""
    scripts = sorted(path for folder in ("lib", "bin") for path in (package / folder).rglob("*.js"))
    if not scripts:
        refuse(
            f"{LINTER} {installed} ships no JavaScript under lib/ or bin/, so the libraries "
            "its notices omit cannot be looked for. The package's layout has changed; read "
            "it before trusting this gate again."
        )
    texts = []
    for path in scripts:
        try:
            texts.append(path.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            refuse(
                f"{LINTER} {installed}'s {path.relative_to(package)} is unreadable "
                f"({exc.strerror}), so the libraries compiled into it cannot be looked for."
            )
    listed_names = {name for name, _ in listed}
    found = []
    for name, (banner, mention) in sorted(UNLISTED.items()):
        versions = sorted({v for text in texts for v in banner.findall(text)})
        if not versions and name not in listed_names and any(mention.search(t) for t in texts):
            refuse(
                f"{LINTER} {installed} still carries {name} code, but neither its "
                "THIRD_PARTY_NOTICES nor a licence banner this gate can read gives its "
                "version. A library compiled in at an unknown version is not an absent one; "
                "read the bundle before trusting this gate again."
            )
        found.extend((name, v) for v in versions if (name, v) not in listed)
    return found


def audit_bundled(root):
    version, pairs, unlisted = bundled_packages(root)
    versions = {}
    for name, ver in pairs:
        versions.setdefault(name, []).append(ver)
    layers = []
    for name, vers in sorted(versions.items()):
        for depth, ver in enumerate(vers):
            if depth == len(layers):
                layers.append({})
            layers[depth][name] = ver

    what = f"npm audit of the libraries bundled in {LINTER} {version}"
    findings = []
    with tempfile.TemporaryDirectory() as scratch:
        for number, layer in enumerate(layers, start=1):
            tree = Path(scratch) / f"bundled-{number}"
            tree.mkdir()
            project = f"bundled-in-redocly-cli-{number}"
            (tree / "package.json").write_text(
                json.dumps(
                    {"name": project, "version": "0.0.0", "private": True, "dependencies": layer}
                ),
                encoding="utf-8",
            )
            packages = {"": {"name": project, "version": "0.0.0", "dependencies": layer}}
            packages.update({f"node_modules/{n}": {"version": v} for n, v in layer.items()})
            (tree / "package-lock.json").write_text(
                json.dumps(
                    {
                        "name": project,
                        "version": "0.0.0",
                        "lockfileVersion": 3,
                        "requires": True,
                        "packages": packages,
                    }
                ),
                encoding="utf-8",
            )

            def check_coverage(deps, layer=layer, number=number):
                # Every library written into the throwaway lockfile is in
                # the audit, or the audit saw less than the bundle holds.
                if deps.get("total") != len(layer):
                    refuse(
                        f"{what} audited {deps.get('total', 0)} package(s) of the "
                        f"{len(layer)} written into throwaway lockfile {number}. An audit of "
                        "part of the bundle proves nothing about the rest of it."
                    )

            layer_findings, _, _ = npm_audit(tree, what, check_coverage)
            for finding in layer_findings:
                finding["where"] = (
                    f"bundled in {LINTER} {version} at "
                    f"{layer.get(finding['package'], 'an unlisted version')}"
                )
            findings.extend(layer_findings)
    banners = (
        " and the licence banners of "
        + ", ".join(f"{name}@{ver}" for name, ver in unlisted)
        + ", which the notices omit"
        if unlisted
        else ""
    )
    summary = (
        f"bundled: {len(versions)} packages ({len(pairs)} name@version pairs) from {LINTER} "
        f"{version}'s THIRD_PARTY_NOTICES{banners}, {len(layers)} npm audit run(s), "
        f"{len(findings)} advisor{'y' if len(findings) == 1 else 'ies'}"
    )
    return findings, summary


# --- The allowlist ----------------------------------------------------------


def load_allowlist(root):
    path = root / FILE
    if not path.exists():
        return {}, False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        refuse(
            f"{FILE} is not readable JSON ({exc}). An allowlist that cannot be read is not "
            "an empty allowlist."
        )
    if not isinstance(data, dict) or not isinstance(data.get("advisories"), list):
        refuse(f"{FILE} carries no `advisories` array, so no exception in it can be read.")
    allowed = {}
    for entry in data["advisories"]:
        if not isinstance(entry, dict):
            refuse(f"{FILE} carries an entry that is not an object: {entry!r:.200}")
        ecosystem, advisory = entry.get("ecosystem"), entry.get("advisory")
        if ecosystem not in BOUND:
            refuse(
                f"{FILE} carries an entry for ecosystem `{ecosystem}`; only "
                f"{', '.join(BOUND)} are audited here.",
                json.dumps(entry, indent=2),
            )
        if not isinstance(advisory, str) or not advisory.strip():
            refuse(
                f"{FILE} carries an entry with no `advisory` identifier, so nothing binds it "
                "to a finding.",
                json.dumps(entry, indent=2),
            )
        unknown = sorted(set(entry) - {"ecosystem", "advisory", "reason", *BOUND[ecosystem]})
        if unknown:
            refuse(
                f"{FILE} entry {advisory} carries {', '.join(unknown)}, which a {ecosystem} "
                "report cannot bind. A field nothing checks reads as a decision nobody took."
            )
        # Keyed by advisory alone, as in the console. One GHSA reported against
        # two packages can therefore be excused for only one of them: the other
        # meets an entry bound to a different package and fails. That is a known
        # limitation, and it fails closed.
        key = (ecosystem, advisory)
        if key in allowed:
            refuse(
                f"{FILE} names {ecosystem} {advisory} twice. Two entries for one advisory "
                "means one of them is never read."
            )
        allowed[key] = {**entry, "used": False}
    return allowed, True


def binding_problem(excuse, finding):
    """Why an entry does not describe the finding it names, or None."""
    reason = excuse.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        return f"{FILE} entry carries no reason — an exception without a written reason is a silent one"
    for field in BOUND[finding["ecosystem"]]:
        if excuse.get(field) != finding[field]:
            return (
                f"{FILE} entry was written for {field} `{json.dumps(excuse.get(field))}`, the "
                f"audit now reports `{json.dumps(finding[field])}` — the advisory moved under "
                "the excuse; decide it again, do not inherit the old reason"
            )
    return None


# --- The verdicts -----------------------------------------------------------


def judge(findings, allowed):
    rows, problems = [], 0
    for finding in findings:
        row = {**finding, "verdict": None, "note": ""}
        severity = finding["severity"]
        blocks = severity is None or ORDER.index(severity) >= BLOCKS_AT
        excuse = allowed.get((finding["ecosystem"], finding["id"]))

        if not blocks:
            row["verdict"], row["note"] = (
                "BELOW",
                f"below the {THRESHOLD} threshold; reported, not blocking",
            )
            if excuse:
                excuse["used"] = True
                row["verdict"] = "FAIL"
                row["note"] = (
                    f"listed in {FILE}, but this advisory is `{severity}` and blocks nothing "
                    "— delete the entry"
                )
                problems += 1
        elif not excuse:
            rated = f"is `{severity}`" if severity else "carries no severity, so it blocks"
            row["verdict"] = "FAIL"
            row["note"] = (
                f"{rated} and is not in {FILE}. Update the dependency, or add an entry with a "
                "written reason."
            )
            problems += 1
        else:
            excuse["used"] = True
            problem = binding_problem(excuse, finding)
            if problem:
                row["verdict"], row["note"] = "FAIL", problem
                problems += 1
            else:
                row["verdict"], row["note"] = "ALLOWED", excuse["reason"]
        rows.append(row)
    return rows, problems


def describe(row):
    if row["ecosystem"] == "npm":
        return f"{row['severity']:<9} {row['range']}"
    fixed = ", ".join(row["fix_versions"]) or "no fixed release"
    return f"{'unrated':<9} {row['version']} (fixed in {fixed})"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--pip-audit",
        default="pip-audit",
        help="the pip-audit binary to run (default: the one on PATH)",
    )
    args = parser.parse_args()
    root = Path.cwd()

    python_findings, python_summary = audit_python(root, args.pip_audit)
    npm_findings, npm_summary = audit_npm(root)
    bundled_findings, bundled_summary = audit_bundled(root)
    allowed, has_allowlist = load_allowlist(root)

    rank = {s: i for i, s in enumerate(ORDER)}
    findings = sorted(
        python_findings + npm_findings + bundled_findings,
        key=lambda f: (f["ecosystem"], -rank.get(f["severity"], len(ORDER)), f["id"]),
    )
    rows, problems = judge(findings, allowed)
    orphans = [entry for entry in allowed.values() if not entry["used"]]

    rule = "=" * 110
    print(
        f"Dependency advisory gate — npm blocks at `{THRESHOLD}` and above; every Python "
        "advisory blocks (pip-audit reports no severity)"
    )
    print(rule)
    print(python_summary)
    print(npm_summary)
    print(bundled_summary)
    print(
        f"{FILE}: {len(allowed)} entr{'y' if len(allowed) == 1 else 'ies'}"
        if has_allowlist
        else f"{FILE}: absent — no advisory has an exception"
    )
    if rows:
        print("-" * 110)
        print(f"{'eco':<5}{'advisory':<22}{'package':<26}{'severity / affected':<40}verdict")
        for row in rows:
            print(
                f"{row['ecosystem']:<5}{row['id']:<22}{row['package']:<26}"
                f"{describe(row):<40}{row['verdict']}"
            )
            if row.get("where"):
                print(f"  in: {row['where']}")
            if row["aliases"]:
                print(f"  aliases: {', '.join(row['aliases'])}")
            print(f"  ↳ {row['note']}")
    print(rule)
    tally = {v: sum(1 for r in rows if r["verdict"] == v) for v in ("FAIL", "ALLOWED", "BELOW")}
    print(
        f"{len(rows)} advisor{'y' if len(rows) == 1 else 'ies'} — "
        + ", ".join(f"{n} {v.lower()}" for v, n in tally.items())
    )

    # A judged failure is reported on stdout with the table it summarises. The
    # runner reads stdout and stderr through separate pipes, so a summary on
    # stderr landed above the table it counts in the CI log. stderr is kept for
    # refusals, which print nothing else.
    if orphans:
        print(f"\nStale entries in {FILE} — no advisory in this audit carries that identifier:")
        for orphan in orphans:
            print(
                f"  FAIL  {orphan['ecosystem']} {orphan['advisory']} — nothing reports it any "
                "more, so this excuse is waiting to cover a finding nobody decided. Delete it."
            )
    if problems or orphans:
        print(
            f"\n{problems + len(orphans)} advisory problem(s). Nothing here passes by being quiet."
        )
        return 1
    print(
        f"\nOK — no blocking advisory is unaccounted for, and no entry in {FILE} has outlived "
        "the finding it describes."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

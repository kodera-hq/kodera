#!/usr/bin/env python3
"""Fail if any tracked file states that a realm belongs to a tenant.

ADR-0006 decides one Keycloak realm per customer **organisation**. A tenant
slug is a DNS label and a Scaleway project name; it is never a realm name, and
an organisation's second tenant reuses the realm the first one already
authenticates against.

The repository contradicted that decision in prose, in configuration and in the
development realm fixtures at the same time, which is worse than any one of
them alone: a reader cannot tell which statement is the design. The first
attempt to close it shipped `git grep -i "realm name" docs` as its check, which
passed while three counterexamples sat in the same directory — the wrong needle
and the wrong haystack. So this reads every tracked file, and it looks for the
phrases that assert the wrong topology rather than for phrases that happen to
accompany the right one.

## What it reads, and what it cannot

This is a text scanner. It matches the *shape* of a claim, not its truth, and
it cannot see a negation: "never a realm per tenant" reads to it exactly like
"a realm per tenant". That is deliberate. A scanner that tried to weigh intent
would be one nobody could predict, and the repository would end up working
around it. Write the correct statement positively — "one realm per
organisation, never one per tenant" — and this is silent. The allowlist is for
quotations that genuinely cannot be rephrased, not for negations.

**The rule set is a floor, not a proof of absence.** It reads the phrasings
this repository actually used, and a green run means those are gone — not that
the topology is stated correctly everywhere. Constructions it does not see, and
that a reader still has to catch: a dot or slash separator (`tenant.realm` —
the separator class holds whitespace, underscore and hyphen and nothing else,
which is also why the legitimate `tenant.realm_*` audit event names do not fire
it), camelCase (`tenantRealm`), the
sentence turned around ("a realm is created for each tenant", "the realm
belongs to the tenant"), a verb outside the short list in `realm-per-tenant`
("each tenant receives a realm"), and a noun wedged in ("a separate realm per
customer tenant"). A whole class stays out of reach on purpose: a *control*
credited to a realm boundary — "separate realm" as the reason two tenants
cannot impersonate each other — is wrong only when the two parties share an
organisation, which is a fact about the subject of the sentence and not about
its words. Two organisations genuinely do have separate realms, so a rule on
that phrase would fire on the correct statement as readily as on the wrong one.
That is a reading job, and it found one in `docs/security/THREAT_MODEL.md`
after this scanner was green.

## The allowlist

An exemption is a claim about one line, so it is checked as one. An entry names
the file, the line, the rule that fired and the exact text that fired it, and
all four must still hold when the check runs: edit the line, renumber it, or
fix the wording, and the entry stops matching and this goes red. The `reason`
comes from a closed vocabulary, and each reason carries a structural condition
the entry must also satisfy — a historical quotation has to sit in a history
section, a deferred contract line has to be under `contracts/`. An entry that
describes nothing is stale, and fails.

That shape answers a specific failure elsewhere in this workspace: an allowlist
that enforced only the presence of a `reason` key, so any string bought an
exemption and the register stopped meaning anything. A `note` is required here
too, but nothing rests on it — the bindings above are what make an entry cost
something to write and impossible to leave behind once the line has moved.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

ALLOWLIST_NAME = "scripts/ci/realm-topology-allowlist.toml"

# This check, its self-test, its mutation probe and its register have to spell
# the forbidden phrases out in order to look for them. Named one by one rather
# than as a glob: `scripts/ci/*` would let the next file dropped in there
# hide a real statement. The probe earned its line the honest way — it was
# written, and this check refused it on eleven of its own lines.
SELF = frozenset(
    {
        "scripts/ci/check-realm-topology.py",
        "scripts/ci/check-realm-topology.selftest.sh",
        "scripts/ci/prove-realm-topology-selftest-binds.sh",
        ALLOWLIST_NAME,
    }
)

# `\b` is the wrong boundary here. An underscore is a word character, so
# `\btenant` never matches inside `KEYCLOAK_DEV_TENANT_REALMS` — which is an
# environment variable that named the topology wrongly and would have walked
# straight past a check written the obvious way. These use an explicit
# alphanumeric lookaround instead, so a phrase embedded in a SCREAMING_SNAKE
# identifier is found and `multitenant` still is not.
NOT_ALNUM_BEFORE = r"(?<![A-Za-z0-9])"
NOT_ALNUM_AFTER = r"(?![A-Za-z0-9])"

# (rule name, what it gets wrong, patterns). The name appears in the error and
# in every allowlist entry that cites it, so widening a rule invalidates those
# entries rather than silently extending them.
RULES = (
    (
        "realm-per-tenant",
        "ADR-0006 puts the realm on the organisation, not on the tenant",
        (
            NOT_ALNUM_BEFORE + r"realms?[\s_-]per[\s_-]tenants?" + NOT_ALNUM_AFTER,
            NOT_ALNUM_BEFORE + r"per[\s_-]tenant[\s_-]realms?" + NOT_ALNUM_AFTER,
            NOT_ALNUM_BEFORE
            + r"one\s+realm\s+(?:for|per)\s+(?:each\s+|every\s+|a\s+|the\s+)?tenants?"
            + NOT_ALNUM_AFTER,
            NOT_ALNUM_BEFORE + r"(?:each|every)\s+tenant\s+(?:has|gets|owns|carries|keeps)"
            r"\s+(?:its\s+own\s+)?(?:a\s+)?realm" + NOT_ALNUM_AFTER,
        ),
    ),
    (
        "tenant-owned-realm",
        "the realm is an organisation property; a tenant owns clients inside it",
        (
            NOT_ALNUM_BEFORE + r"tenants?(?:['’]s|s['’])?[\s_-]realms?" + NOT_ALNUM_AFTER,
            # One separator character is not enough. The pattern above reads
            # "the tenant's realm" and walks straight past "the tenant's own
            # realm" and "the tenant's own Keycloak realm", which say the same
            # thing more strongly — an adjective between the possessive and the
            # noun is a hole, not a rewording. So a possessive followed by an
            # ownership adjective, optionally one further word, then the noun.
            # Measured over this tree: exactly the two contract lines, nothing
            # else. Deliberately narrow — an open-ended gap between "tenant's"
            # and "realm" would swallow whole sentences.
            NOT_ALNUM_BEFORE
            + r"tenants?(?:['’]s|s['’])\s+(?:own|sole|dedicated|separate|private|individual)"
            r"(?:\s+[A-Za-z]+)?\s+realms?" + NOT_ALNUM_AFTER,
        ),
    ),
    (
        "realm-named-from-tenant",
        "a realm is named from the organisation slug, never from a tenant slug",
        (
            r"[\"']realm[\"']\s*:\s*[\"']tenant[-_]",
            NOT_ALNUM_BEFORE + r"realms?\s*[:=]\s*[\"']?tenant[-_]",
            r"/realms/tenant[-_]",
        ),
    ),
)

COMPILED = tuple(
    (name, tuple(re.compile(p, re.IGNORECASE) for p in patterns)) for name, _, patterns in RULES
)
WHY = {name: why for name, why, _ in RULES}
RULE_NAMES = frozenset(WHY)

# A history section is one of these headings, at any level. `docs/adr/` is
# exempt wholesale: an accepted ADR is never edited, only superseded, so its
# text is by definition the record of a decision at a moment.
HISTORY_HEADING = re.compile(
    r"^#{1,6}\s*(?:changelog|history|revisions?|options\s+considered|superseded)\b",
    re.IGNORECASE,
)
HEADING = re.compile(r"^#{1,6}\s")

# reason -> (structural condition, extra fields that must be non-empty)
REASONS = {
    "historical-quotation": (
        "the line sits under a changelog, history, revisions, options-considered "
        "or superseded heading, or in docs/adr/",
        (),
    ),
    "deferred-contract": (
        "the file is under contracts/",
        ("owner",),
    ),
}


class AllowlistError(Exception):
    """An allowlist entry that does not hold up."""


def tracked_files(root, skip):
    """Every file git knows about under `root`, minus this check's own files."""
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git is not on PATH, so the tracked file list cannot be read")
    # A fixed argument vector with a resolved executable and no shell; the
    # only variable is the directory this check was pointed at.
    out = subprocess.run(  # noqa: S603
        [git, "ls-files", "-z"],
        cwd=root,
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    return [name for name in out.split("\0") if name and name not in skip]


def read_lines(root, path):
    """Text lines of a tracked file, or None when it is not UTF-8 text."""
    try:
        return (root / path).read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, OSError):
        return None


def findings_in(path, lines):
    """Every rule hit in one file, as (path, line, rule, text, column).

    Two patterns of the same rule often see the same sentence — "one realm per
    tenant" contains "realm per tenant" — and that is one statement, not two.
    A hit whose span sits entirely inside a longer hit is therefore dropped, so
    the count this check prints is a count of statements a reader would
    recognise. Overlapping-but-not-contained hits are kept: they are two
    different things wrong with one line.
    """
    found = []
    for number, line in enumerate(lines, start=1):
        hits = []
        for name, patterns in COMPILED:
            for pattern in patterns:
                for hit in pattern.finditer(line):
                    hits.append((hit.start(), hit.end(), name, hit.group(0)))
        hits.sort(key=lambda h: (h[0], -(h[1] - h[0])))
        kept = []
        for start, end, name, text in hits:
            if any(k[0] <= start and end <= k[1] for k in kept):
                continue
            kept.append((start, end, name, text))
            found.append((path, number, name, text, start))
    return found


def in_history_section(lines, number):
    """True when the nearest heading above `number` opens a history section."""
    for line in reversed(lines[: number - 1]):
        if HEADING.match(line):
            return bool(HISTORY_HEADING.match(line))
    return False


def load_allowlist(path):
    """The register's entries, or an empty list when there is no register."""
    if not path.exists():
        return []
    with open(path, "rb") as handle:
        data = tomllib.load(handle)
    entries = data.get("allow", [])
    if not isinstance(entries, list):
        raise AllowlistError("`allow` must be an array of tables")
    return entries


def check_entry(entry, index, keys, at_line, lines_by_path):
    """Return the finding this entry exempts, or raise saying why it does not."""
    where = f"entry {index}"
    for field in ("path", "line", "rule", "match", "reason", "note"):
        if field not in entry:
            raise AllowlistError(f"{where}: missing `{field}`")

    path, line = entry["path"], entry["line"]
    rule, match, reason = entry["rule"], entry["match"], entry["reason"]
    where = f"entry {index} ({path}:{line})"

    if not isinstance(line, int) or isinstance(line, bool):
        raise AllowlistError(f"{where}: `line` must be an integer")
    if not str(entry["note"]).strip():
        raise AllowlistError(f"{where}: `note` is empty")
    if rule not in RULE_NAMES:
        raise AllowlistError(f"{where}: `rule` is '{rule}', not one of {sorted(RULE_NAMES)}")
    if reason not in REASONS:
        raise AllowlistError(f"{where}: `reason` is '{reason}', not one of {sorted(REASONS)}")

    condition, required = REASONS[reason]
    for field in required:
        if not str(entry.get(field, "")).strip():
            raise AllowlistError(f"{where}: reason '{reason}' requires a non-empty `{field}`")

    lines = lines_by_path.get(path)
    if lines is None:
        raise AllowlistError(f"{where}: '{path}' is not a tracked text file")
    if not 1 <= line <= len(lines):
        raise AllowlistError(f"{where}: '{path}' has {len(lines)} lines; line {line} is not one")

    # The binding that carries the weight. An exemption must describe a hit
    # this run actually produced, with the same rule and the same text — so a
    # fixed line, a moved line or a retargeted entry all break it rather than
    # carrying the exemption on to wording nobody approved.
    key = (path, line, rule, match)
    if key not in keys:
        here = sorted(f"'{t}' ({r})" for r, t in at_line.get((path, line), ()))
        raise AllowlistError(
            f"{where}: stale — no '{rule}' match of '{match}' on that line; "
            f"this check found {', '.join(here) if here else 'nothing'} there"
        )

    if reason == "historical-quotation" and not (
        path.startswith("docs/adr/") or in_history_section(lines, line)
    ):
        raise AllowlistError(f"{where}: reason '{reason}' requires that {condition}")
    if reason == "deferred-contract" and not path.startswith("contracts/"):
        raise AllowlistError(f"{where}: reason '{reason}' requires that {condition}")

    return key


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parents[2]),
        help="repository to scan (default: the repository this script lives in)",
    )
    parser.add_argument(
        "--allowlist",
        default=None,
        help=f"register of bound exemptions (default: <root>/{ALLOWLIST_NAME})",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    root = Path(args.root).resolve()
    allowlist_path = Path(args.allowlist) if args.allowlist else root / ALLOWLIST_NAME
    shown = allowlist_path.name if args.allowlist else ALLOWLIST_NAME

    # The register has to quote the phrases it exempts, so whichever file is
    # serving as the register is not scanned. It is named on the command line
    # rather than guessed, and CI passes no `--allowlist` at all, so this
    # cannot be used to move a real statement out of view.
    skip = set(SELF)
    try:
        skip.add(str(allowlist_path.resolve().relative_to(root)))
    except ValueError:
        pass

    lines_by_path, unreadable = {}, []
    for path in tracked_files(root, skip):
        lines = read_lines(root, path)
        if lines is None:
            unreadable.append(path)
        else:
            lines_by_path[path] = lines

    findings = []
    for path, lines in lines_by_path.items():
        findings.extend(findings_in(path, lines))

    # Two views of the same scan: the exact hits, so the count is a count of
    # occurrences rather than of lines, and a key set the allowlist speaks in.
    # An entry covers every occurrence of its text on its line, which is the
    # only sane reading of "this line, this phrase, this reason".
    keys = {(p, n, r, t) for p, n, r, t, _ in findings}
    at_line = {}
    for p, n, r, t, _ in findings:
        at_line.setdefault((p, n), set()).add((r, t))

    problems = []
    try:
        entries = load_allowlist(allowlist_path)
    except (AllowlistError, tomllib.TOMLDecodeError) as exc:
        print(f"::error file={shown}::{exc}")
        entries = []
        problems.append("the allowlist could not be read")

    allowed, seen = {}, {}
    for index, entry in enumerate(entries, start=1):
        try:
            key = check_entry(entry, index, keys, at_line, lines_by_path)
        except AllowlistError as exc:
            print(f"::error file={shown}::{exc}")
            problems.append(str(exc))
            continue
        if key in seen:
            message = f"entry {index} repeats entry {seen[key]}: {key[0]}:{key[1]} '{key[3]}'"
            print(f"::error file={shown}::{message}")
            problems.append(message)
            continue
        seen[key] = index
        allowed[key] = entry["reason"]

    offences = sorted(f for f in findings if f[:4] not in allowed)
    for path, line, rule, text, _ in offences:
        print(
            f"::error file={path},line={line}::'{text}' makes the realm a tenant's — "
            f"{WHY[rule]} ({rule}). See docs/adr/0006-kodera-identity-topology.md"
        )

    if unreadable:
        print(f"{len(unreadable)} tracked file(s) are not UTF-8 text and were not read:")
        for path in unreadable:
            print(f"  {path}")

    if offences or problems:
        if offences:
            by_file = {}
            for path, _, _, _, _ in offences:
                by_file[path] = by_file.get(path, 0) + 1
            print(f"\n{len(offences)} realm-per-tenant statement(s) in {len(by_file)} file(s):")
            for path in sorted(by_file):
                print(f"  {by_file[path]:3d}  {path}")
        if problems:
            print(f"\n{len(problems)} allowlist entr(y/ies) did not hold up.")
        print(f"\nscanned {len(lines_by_path)} tracked files under {root}")
        return 1

    print(f"no realm-per-tenant statement in {len(lines_by_path)} tracked files")
    if allowed:
        # `len(allowed)` counts distinct entries, and an entry covers every
        # occurrence of its text on its line — so this is a count of
        # exemptions, which is not the unit the offence count above uses.
        print(f"{len(allowed)} registered exemption(s), each still bound to its line and reason:")
        for key in sorted(allowed):
            path, line, rule, text = key
            print(f"  {path}:{line}  {rule}  '{text}'  [{allowed[key]}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())

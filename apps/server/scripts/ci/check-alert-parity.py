#!/usr/bin/env python3
"""Compare the alert catalogue with the paging tables it is meant to restate.

`docs/specs/OBSERVABILITY_STACK.md` §6 catalogues every alert with a PromQL
sketch and a base severity. `docs/specs/SLO.md` §5.1 states the condition of the
hard-down alerts in prose, §7.1 states which severity pages and when, and the
`Escalations` table under it lists the one alert that changes severity. Four
statements of the same facts, in two documents.

§7 item 5 of the stack document has always described a check over the severity
columns. It was never written: the numbers under it were simulated by hand, and
the hand was wrong — it counted 37 catalogue alerts where there are 36, and 35
bare-digit severity cells where there are 34. This is that check, and it does
more than severities, because severities were not where the two documents came
apart.

They came apart on **what a threshold counts**. `IdPOutageFleetWide` fired on
`login_availability` bad on "≥ 3 tenants"; the realm-topology work moved the
identity provider's grain from the tenant to the organisation, restated the
alert in §5.1 as "≥ 3 organisations", and left the executable sketch counting
tenant series. Two documents that had agreed now disagreed, and the sketch — the
one a rule is written from — still paged at any hour for a single three-tenant
customer losing its own realm. A severity comparison sees none of that: both
documents said Sev-1 throughout.

So the checks are:

1. **Scope.** Every catalogue alert has exactly one row in §7.1, except the
   documented exception, which must have none. The exception list has exactly
   one member; a second severity-less alert fails rather than joining it.
2. **Severity parity** on the leading digit of the catalogue's `Sev` cell.
3. **Escalation parity.** A `Sev` cell that is not a bare digit needs a row in
   the `Escalations` table, and the two numbers must match it. A row there for
   an alert whose cell *is* a bare digit fails too: the table is the list, so it
   may not carry an alert that does not escalate.
4. **Counting-grain parity.** A sketch that counts across the fleet
   (`count(...) >= N`) must say what it counts one series of — `count by
   (<label>)` — and:

   - `<label>` must be declared in the required-label table at §2.2. A condition
     phrased over a dimension the pipeline does not carry cannot be written, and
     "settled when the rules are written" is where that discovery would have
     been made, months after the wording was agreed.
   - the alert's §5.1 condition must state the same first firing integer
     (`N` for `>= N`, `N + 1` for `> N`);
   - and it must state it in the same unit. The noun in §5.1 is matched against
     the entity labels of §2.2 — `organisation_slug` admits "organisation" and
     "organisations", `tenant_slug` admits "tenant" and "tenants" — so the two
     documents cannot name different things while agreeing on a number.

   The mapping is derived from the label table rather than listed here, so a new
   entity dimension is usable the moment it is declared and never before.

   If this rule binds no alert at all, the run fails. A rule that quietly
   matches nothing is the failure mode of every check in this repository's
   history that had to be written twice.
5. **The same threshold restated in prose.** Rules 1 to 4 compare tables, and
   this condition was not only in tables. It was written in three places, two
   were corrected, and the third was left saying the opposite — so every
   sentence under `docs/` that names one of these alerts *and* states a
   threshold has to state the same number in the same unit. Deliberately
   narrow: only a line naming the alert is read, and only the two idioms a
   threshold is actually written in (`≥ N nouns`, `N or more nouns`) count as
   one, so an ordinary sentence about tenants is not mistaken for a rule.
   Changelog sections and `docs/adr/` are exempt — a record of the behaviour
   before a correction is not a restatement of the rule, and a check that
   reddened on those would be switched off within a week.

Usage: `python3 scripts/ci/check-alert-parity.py [REPO_ROOT]`. Standard
library only, so it needs nothing beyond the interpreter on the runner.
"""

import re
import sys
from pathlib import Path

STACK = Path("docs/specs/OBSERVABILITY_STACK.md")
SLO = Path("docs/specs/SLO.md")

# The one catalogue alert with no severity and no §7.1 row, by name. Stated as a
# closed list: a second one is a decision, and it fails here until it is argued
# for in both documents.
NO_SEVERITY = ("Watchdog",)

# Sections whose tables are read. Anchored on the numbered heading text so a new
# subsection cannot slip a table in unread, and an old one cannot fall out of
# scope by being renumbered without anybody noticing.
CATALOGUE_HEADING = re.compile(r"^### 6\.\d+ ")
LABELS_HEADING = re.compile(r"^### 2\.2 ")
HARD_DOWN_HEADING = re.compile(r"^### 5\.1 ")
PAGING_HEADING = re.compile(r"^### 7\.1 ")

ALERT_CELL = re.compile(r"^`([A-Za-z][A-Za-z0-9]*)`$")
LABEL_CELL = re.compile(r"^`([a-z][a-z0-9_]*)`$")
BARE_DIGIT = re.compile(r"^(\d)$")
WITH_ESCALATION = re.compile(r"^(\d) \((\d) on .+\)$")
SEVERITY_ROW = re.compile(r"^Sev-(\d)$")
ESCALATION_SEV = re.compile(r"^Sev-(\d)$")

# A sketch that counts series across the fleet, with the threshold it fires on.
FLEET_COUNT = re.compile(r"\bcount\s*\(.*?\)\s*(>=|>)\s*(\d+)")
# The grouping inside it: `count by (organisation_slug) (...)`.
COUNT_BY = re.compile(r"\bcount\s+by\s+\(\s*([a-z_][a-z0-9_]*)\s*\)")
# The threshold as §5.1 words it, and the noun it is a count of.
PROSE_COUNT = re.compile(r"(?:>=|≥)\s*(\d+)\s+([a-z]+)")

# An entity dimension is a label named `<entity>_slug`. Everything the check
# knows about nouns comes from this suffix, so the vocabulary is the label
# table's and not a list kept in step with it by hand.
ENTITY_SUFFIX = "_slug"

# --- rule 5: the same threshold restated in prose --------------------------
#
# Every document under `docs/`, minus the ADRs. The sweep is deliberately wider
# than the two files the tables come from: this whole round exists because a
# rule stated in three places was corrected in two, and the one left behind was
# in a file nobody had listed.
PROSE_ROOT = Path("docs")
# An accepted ADR is never edited, only superseded, so its text is the record of
# a decision at a moment — the same carve-out `check-realm-topology.py` makes.
PROSE_EXEMPT_DIR = Path("docs/adr")
# And the same carve-out inside a document, for the same reason.
HISTORY_HEADING = re.compile(
    r"^#{1,6}\s*(?:changelog|history|revisions?|options\s+considered|superseded)\b",
    re.IGNORECASE,
)
HEADING = re.compile(r"^#{1,6}\s")

NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}

# The two idioms a threshold is written in: `≥ 3 organisations`, and `three or
# more organisations`. Both require the noun immediately after the number, which
# is what keeps this from reading an ordinary sentence as a rule.
RESTATED = re.compile(
    r"(?:(?:>=|≥)\s*(\d+)|\b(" + "|".join(NUMBER_WORDS) + r")\s+or\s+more)\s+([a-z]+)"
)


class ReadError(Exception):
    """A document shape the check could not read.

    Raised, never skipped: a table this check cannot parse is a table whose
    agreement it would otherwise report without having looked.
    """


def plain(cell):
    """A table cell with Markdown emphasis and code ticks removed."""
    return cell.replace("**", "").replace("*", "").replace("`", "").strip()


def rows_under(lines, heading, stop=re.compile(r"^#{2,4} ")):
    """Every table row under the first heading matching `heading`.

    Returns [(line number, [cells])]. A section that is not there raises: the
    alternative is a check that reports agreement between a table and nothing.
    """
    start = None
    for number, line in enumerate(lines, start=1):
        if heading.match(line):
            start = number
            break
    if start is None:
        raise ReadError(f"no section matching {heading.pattern!r}")

    found = []
    for number, line in enumerate(lines[start:], start=start + 1):
        if stop.match(line) and not heading.match(line):
            break
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if all(set(cell) <= {"-", ":"} for cell in cells):  # the ruler row
            continue
        found.append((number, cells))
    return found


def all_rows_under(lines, heading):
    """`rows_under`, over every section matching the heading rather than one."""
    found = []
    starts = [n for n, line in enumerate(lines, start=1) if heading.match(line)]
    if not starts:
        raise ReadError(f"no section matching {heading.pattern!r}")
    for start in starts:
        for number, line in enumerate(lines[start:], start=start + 1):
            if re.match(r"^#{2,4} ", line):
                break
            if not line.startswith("|"):
                continue
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if all(set(cell) <= {"-", ":"} for cell in cells):
                continue
            found.append((number, cells))
    return found


def catalogue(lines):
    """{alert: (line, severity cell, expression)} from §6."""
    alerts = {}
    for number, cells in all_rows_under(lines, CATALOGUE_HEADING):
        name = ALERT_CELL.match(cells[0])
        if not name:
            continue  # a header row, or a row that is not an alert row
        if len(cells) < 4:
            raise ReadError(
                f"{STACK}:{number}: catalogue row for {cells[0]} has "
                f"{len(cells)} cells; an alert row has Alert, Expression, For, "
                f"Sev and Runbook"
            )
        if name.group(1) in alerts:
            raise ReadError(
                f"{STACK}:{number}: {name.group(1)} is catalogued twice; one "
                f"row would be compared and the other silently ignored"
            )
        alerts[name.group(1)] = (number, plain(cells[3]), plain(cells[1]))
    if not alerts:
        raise ReadError(f"{STACK}: no alert rows found under §6")
    return alerts


def declared_labels(lines):
    """The label names §2.2 requires every series to carry."""
    labels = set()
    for _, cells in rows_under(lines, LABELS_HEADING):
        found = LABEL_CELL.match(cells[0])
        if found:
            labels.add(found.group(1))
    if not labels:
        raise ReadError(f"{STACK}: no labels found in the §2.2 table")
    return labels


def entity_nouns(labels):
    """{noun: label} for every `<entity>_slug` in the label table."""
    nouns = {}
    for label in labels:
        if label.endswith(ENTITY_SUFFIX):
            entity = label[: -len(ENTITY_SUFFIX)]
            nouns[entity] = label
            nouns[entity + "s"] = label
    return nouns


def paging_rows(lines):
    """{alert: (line, severity)} from the §7.1 table."""
    where = {}
    for number, cells in rows_under(lines, PAGING_HEADING):
        severity = SEVERITY_ROW.match(plain(cells[0]))
        if not severity:
            continue
        for name in re.findall(r"`([A-Za-z][A-Za-z0-9]*)`", cells[1]):
            if name in where:
                raise ReadError(
                    f"{SLO}:{number}: {name} has a second §7.1 row; the table "
                    f"says every alert appears in exactly one"
                )
            where[name] = (number, int(severity.group(1)))
    if not where:
        raise ReadError(f"{SLO}: no severity rows found in the §7.1 table")
    return where


def escalation_rows(lines):
    """{alert: (line, base, escalated)} from the Escalations table under §7.1."""
    rows = {}
    for number, cells in rows_under(lines, PAGING_HEADING):
        name = ALERT_CELL.match(cells[0])
        if not name or len(cells) < 3:
            continue
        base = ESCALATION_SEV.match(plain(cells[1]))
        into = ESCALATION_SEV.match(plain(cells[2]))
        if not base or not into:
            raise ReadError(
                f"{SLO}:{number}: escalation row for {name.group(1)} does not "
                f"read 'Sev-n' in both severity cells"
            )
        rows[name.group(1)] = (number, int(base.group(1)), int(into.group(1)))
    return rows


def hard_down_rows(lines):
    """{alert: (line, condition)} from the §5.1 table."""
    rows = {}
    for number, cells in rows_under(lines, HARD_DOWN_HEADING):
        name = ALERT_CELL.match(cells[0])
        if name:
            rows[name.group(1)] = (number, plain(cells[1]))
    if not rows:
        raise ReadError(f"{SLO}: no alert rows found in the §5.1 table")
    return rows


def error(path, line, message):
    print(f"::error file={path},line={line}::{message}")


def check_scope(alerts, paging):
    """Rule 1."""
    failures = 0
    for name in NO_SEVERITY:
        if name not in alerts:
            error(
                STACK,
                1,
                f"{name} is listed as the severity-less exception but is not in the catalogue",
            )
            failures += 1
        elif name in paging:
            error(
                SLO,
                paging[name][0],
                f"{name} is the documented severity-less exception, so it must "
                f"have no §7.1 row; this one gives it Sev-{paging[name][1]}",
            )
            failures += 1

    for name, (line, cell, _) in sorted(alerts.items()):
        if name in NO_SEVERITY:
            if cell not in ("—", "-", ""):
                error(
                    STACK,
                    line,
                    f"{name} is the severity-less exception but its Sev cell "
                    f"reads {cell!r}; give it a §7.1 row or leave the cell empty",
                )
                failures += 1
            continue
        if name not in paging:
            error(
                STACK,
                line,
                f"{name} is catalogued in §6 but has no row in {SLO} §7.1, so "
                f"nothing says whether it pages. Exactly one alert may have no "
                f"severity, and that is {', '.join(NO_SEVERITY)}",
            )
            failures += 1

    for name, (line, severity) in sorted(paging.items()):
        if name not in alerts:
            error(
                SLO,
                line,
                f"§7.1 gives {name} Sev-{severity}, but no row in {STACK} §6 "
                f"catalogues it; a severity with no alert pages nobody",
            )
            failures += 1
    return failures


def check_severity(alerts, paging, escalations):
    """Rules 2 and 3. Returns (failures, compared, escalations compared)."""
    failures = compared = escalated = 0
    for name, (line, cell, _) in sorted(alerts.items()):
        if name in NO_SEVERITY or name not in paging:
            continue
        paging_line, severity = paging[name]

        bare = BARE_DIGIT.match(cell)
        both = WITH_ESCALATION.match(cell)
        if not bare and not both:
            error(
                STACK,
                line,
                f"{name}'s Sev cell reads {cell!r}. It is either a bare digit, "
                f"or a base digit and an escalation in parentheses which the "
                f"Escalations table under {SLO} §7.1 must also carry",
            )
            failures += 1
            continue

        base = int((bare or both).group(1))
        compared += 1
        if base != severity:
            error(
                STACK,
                line,
                f"{name} is Sev-{base} in the catalogue and Sev-{severity} in "
                f"{SLO} §7.1:{paging_line}. §7.1 is the table that is right",
            )
            failures += 1

        if both:
            escalated += 1
            if name not in escalations:
                error(
                    STACK,
                    line,
                    f"{name}'s Sev cell escalates to {both.group(2)}, and the "
                    f"Escalations table under {SLO} §7.1 has no row for it. "
                    f"That table is the list, not this cell",
                )
                failures += 1
            else:
                escalation_line, listed_base, listed_into = escalations[name]
                if (listed_base, listed_into) != (base, int(both.group(2))):
                    error(
                        SLO,
                        escalation_line,
                        f"{name} escalates Sev-{listed_base} → Sev-{listed_into} "
                        f"here and {base} → {both.group(2)} in {STACK}:{line}",
                    )
                    failures += 1
        elif name in escalations:
            error(
                SLO,
                escalations[name][0],
                f"{name} has an Escalations row but a bare Sev cell in "
                f"{STACK}:{line}; an alert that escalates says so in both",
            )
            failures += 1
    return failures, compared, escalated


def check_counting(alerts, hard_down, labels, nouns):
    """Rule 4. Returns (failures, alerts bound by the rule, {alert: (label, N)})."""
    failures = bound = 0
    grains = {}
    for name, (line, _, expression) in sorted(alerts.items()):
        threshold = FLEET_COUNT.search(expression)
        if not threshold:
            continue
        bound += 1
        # Counted series are integers; strictness changes the first firing value.
        wanted = int(threshold.group(2)) + (threshold.group(1) == ">")

        grouping = COUNT_BY.search(expression)
        if not grouping:
            error(
                STACK,
                line,
                f"{name} counts series and fires at {wanted}, but nothing says "
                f"one series of what: write `count by (<label>)` inside it. "
                f"Counted flat, this is a count of probe series, which is a "
                f"count of tenants wherever a tenant carries one",
            )
            failures += 1
            continue

        label = grouping.group(1)
        grains[name] = (label, wanted)
        if label not in labels:
            error(
                STACK,
                line,
                f"{name} groups by {label!r}, which the required-label table at "
                f"§2.2 does not declare. The condition cannot be written over a "
                f"dimension the pipeline does not carry; declare the label there "
                f"first",
            )
            failures += 1
            continue

        if name not in hard_down:
            error(
                SLO,
                1,
                f"{name} fires on a fleet-wide count in {STACK}:{line} and has "
                f"no §5.1 row saying what that count is of",
            )
            failures += 1
            continue

        prose_line, condition = hard_down[name]
        stated = PROSE_COUNT.search(condition)
        if not stated:
            error(
                SLO,
                prose_line,
                f"{name}'s condition does not state a threshold as '≥ N nouns'. "
                f"{STACK}:{line} fires it at {wanted} of something, and this row "
                f"is where the something is named",
            )
            failures += 1
            continue

        if int(stated.group(1)) != wanted:
            error(
                SLO,
                prose_line,
                f"{name} fires at {stated.group(1)} here and at {wanted} in {STACK}:{line}",
            )
            failures += 1

        noun = stated.group(2)
        if noun not in nouns:
            error(
                SLO,
                prose_line,
                f"{name} counts {noun!r}, which is not an entity in the "
                f"required-label table at {STACK} §2.2. The dimensions there "
                f"are: {', '.join(sorted(nouns))}",
            )
            failures += 1
        elif nouns[noun] != label:
            error(
                STACK,
                line,
                f"{name} groups by {label!r} and {SLO}:{prose_line} counts "
                f"{noun!r}, which is {nouns[noun]!r}. One organisation's realm "
                f"failing marks every one of its tenants bad in the same "
                f"interval, so counted per tenant this fires on one customer "
                f"and pages as a fleet-wide event",
            )
            failures += 1

    if bound == 0:
        error(
            STACK,
            1,
            "no catalogue expression counts across the fleet, so the "
            "counting-grain rule compared nothing. Either an alert lost its "
            "`count(...)` sketch or the rule stopped matching it; a rule that "
            "matches nothing reports agreement it never looked for",
        )
        failures += 1
    return failures, bound, grains


def prose_documents(root):
    """Every document under `docs/`, outside `docs/adr/`, sorted."""
    directory = root / PROSE_ROOT
    if not directory.is_dir():
        return []
    exempt = root / PROSE_EXEMPT_DIR
    return sorted(
        path for path in directory.rglob("*.md") if exempt not in path.parents and path != exempt
    )


def check_restatements(root, grains, nouns):
    """Rule 5. Returns (failures, documents swept, restatements checked).

    Rules 2 to 4 compare tables. This one is the reason there is a round five of
    these two documents: the threshold was stated in three places, two were
    corrected, and the third — in a file nobody had listed — was left saying the
    opposite. So every sentence in `docs/` that names one of these alerts *and*
    states a threshold has to state the same one, in the same unit.

    Kept narrow on purpose. Only a line naming the alert is read, and only the
    two idioms a threshold is actually written in count as one, so an ordinary
    sentence about tenants is not mistaken for a rule. History sections and the
    ADRs are exempt: a changelog entry describing the old behaviour is a record,
    not a restatement, and a check that reddened on those would be turned off.
    """
    failures = restatements = 0
    documents = prose_documents(root)
    for path in documents:
        relative = path.relative_to(root)
        in_history = False
        for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if HEADING.match(raw):
                in_history = bool(HISTORY_HEADING.match(raw))
            if in_history:
                continue
            line = plain(raw)
            for name, (label, wanted) in grains.items():
                if not re.search(rf"\b{re.escape(name)}\b", line):
                    continue
                stated = RESTATED.search(line)
                if not stated:
                    continue
                restatements += 1
                number_word = stated.group(2)
                count = NUMBER_WORDS[number_word] if number_word else int(stated.group(1))
                noun = stated.group(3)
                if count != wanted:
                    error(
                        relative,
                        number,
                        f"this sentence fires {name} at {count} and {STACK} fires it at {wanted}",
                    )
                    failures += 1
                if noun not in nouns:
                    error(
                        relative,
                        number,
                        f"this sentence counts {name} in {noun!r}, which is not "
                        f"an entity in the required-label table at {STACK} §2.2. "
                        f"The dimensions there are: {', '.join(sorted(nouns))}",
                    )
                    failures += 1
                elif nouns[noun] != label:
                    error(
                        relative,
                        number,
                        f"this sentence counts {name} in {noun!r} ({nouns[noun]}) "
                        f"and {STACK} groups it by {label!r}. Correcting a "
                        f"threshold in one place and not another is how these two "
                        f"documents came apart the last time",
                    )
                    failures += 1
    return failures, len(documents), restatements


def main(argv):
    if len(argv) > 2:
        print(f"::error::usage: {Path(argv[0]).name} [REPO_ROOT]")
        return 1
    root = Path(argv[1] if len(argv) == 2 else ".")

    try:
        stack = (root / STACK).read_text(encoding="utf-8").splitlines()
        slo = (root / SLO).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        print(f"::error::{exc}")
        return 1

    try:
        alerts = catalogue(stack)
        labels = declared_labels(stack)
        paging = paging_rows(slo)
        escalations = escalation_rows(slo)
        hard_down = hard_down_rows(slo)
    except ReadError as exc:
        print(f"::error::{exc}")
        return 1

    nouns = entity_nouns(labels)
    failures = check_scope(alerts, paging)
    severity_failures, compared, escalated = check_severity(alerts, paging, escalations)
    failures += severity_failures
    counting_failures, bound, grains = check_counting(alerts, hard_down, labels, nouns)
    failures += counting_failures
    prose_failures, documents, restated = check_restatements(root, grains, nouns)
    failures += prose_failures

    if failures:
        return 1

    print(
        f"{len(alerts)} catalogued alerts, {len(NO_SEVERITY)} out of scope; "
        f"{compared} severities equal to their SLO.md §7.1 row, {escalated} of "
        f"them with an Escalations row that matches; {bound} fleet-wide count "
        f"grouped by a label §2.2 declares and counting what §5.1 says it counts; "
        f"{restated} prose restatement(s) of that threshold across {documents} "
        f"document(s) under docs/, all agreeing"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

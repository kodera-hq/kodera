"""Prove the claim `JobKind` makes about itself.

The schema's own description says:

    **This enum and §2 of `docs/domain/JOB_CATALOGUE.md` are one list**: the
    catalogue is the closed set, each kind there carrying its ordered steps, a
    named idempotency proof per step, a timeout, a retry class and a
    compensation, and a contract test compares the two in both directions.

No test file referenced `JobKind`. A sentence claiming a test exists is worse
than a missing test, because it tells a reader nobody has to check — so this is
that test, and the rules below are the sentence, clause by clause:

  JOB-LIST   the enum and §2's kind column are the same list, in the same order.
             The three ways they can disagree are reported apart, because a kind
             the catalogue lacks, a kind the enum lacks and a pair in the wrong
             order call for three different repairs.
  JOB-ROW    every delimiter row in the document anchors a table this read. A
             table the parser failed to recognise simply vanished from the scan,
             leaving only a smaller number in a summary nothing asserts. Five
             shapes did it, and the worst was omitting the outer pipes -- GFM
             allows that on every row, and it read fifteen kinds out of sixteen
             and called them agreed in both directions. Indented, quoted and
             pipe-less tables are read, not refused; a steps table outside §2 is
             refused, because nothing there would read it.
  JOB-DOC    every kind in §2 is named by exactly one `###` heading under it.
             That is "the catalogue is the closed set": a row added to the table
             with nothing documenting it is how a kind becomes a name only. Some
             headings name two kinds, which is allowed and is why this counts
             headings naming a kind rather than headings per kind.
  JOB-STEP   every step row under §2 fills its proof, timeout, retry and
             compensation cells, and its proof and retry class are names §1
             actually defines. That is "a named idempotency proof per step, a
             timeout, a retry class and a compensation" -- a typo in a proof
             name reads as a proof and is not one.

An input this cannot read or parse exits 2, never 1: "the contract disagrees with
the catalogue" and "I could not read one of them" are different results, and a gate
that conflates them cannot be trusted in either direction. That included invalid
YAML, which escaped as a traceback at status 1 until a review found it.

Every rule here is matched as loosely as the claim allows and no looser. Nine of
the self-test's cases assert that a CORRECT document is accepted, and each was a
real refusal of a legitimate edit first: an escaped pipe in a cell, a non-step
table under a kind, a footnote on a kind, emphasis round a proof name. Over-strict
is a defect too, and a gate that refuses correct work gets switched off.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import yaml

# libyaml when the runner has it: a 380 KB contract parses in 0.04 s against the
# pure-Python parser's 0.38 s, and the mutation suite parses it once per case per
# mutation. Correctness is identical and both raise `yaml.YAMLError`, so the
# fallback changes only how long the proof takes. `getattr` rather than a
# try/except import because the two loaders are unrelated types, and naming one in
# an `except` branch makes the name's type depend on which branch ran.
SAFE_LOADER: Any = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

CONTRACT = Path("contracts/core-api.openapi.yaml")
CATALOGUE = Path("docs/domain/JOB_CATALOGUE.md")

# Read from §2's own heading text rather than hard-coded, so renaming the
# section is a parse refusal rather than a silent scan of the wrong bytes.
KINDS_SECTION = re.compile(r"^## 2\.(?=[.\s])")
SUBSECTION = re.compile(r"^### (.+)$")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
# The HTML blocks that can hold document-looking text. `<pre>` is the one that
# mattered: a `###` inside it counted as a kind's section and rendered as nothing.
HTML_OPEN = re.compile(r"^\s{0,3}<(pre|div|details|table|blockquote)\b", re.IGNORECASE)
CODE = re.compile(r"`([^`]+)`")
# Markdown escapes a literal pipe inside a cell as `\|`.
CELL = re.compile(r"(?<!\\)\|")

KIND_HEADER = "Kind"
STEP_MARKER = "#"
STEP_TAIL = "Compensation"
STEP_COLUMNS = 6

# A parenthetical EXPLAINS a proof; it does not name one. The real document writes
# `` `natural-key` (`tenant`, `name`, `version`) ``, so the identifiers inside the
# brackets are not proofs -- and every code span outside them is. Reading only a
# leading run joined by `+` or `and` missed `or`, `/`, `,` and `<br>`, each of which
# GFM renders as two named proofs, and the first of which §1's own wording ("is one
# of") invites. Every name in the cell is checked now, not the first run of them.
PARENTHETICAL = re.compile(r"\([^()]*\)")
# An HTML comment and a bare entity both render to nothing a reader can see.
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
ENTITY = re.compile(r"&[a-zA-Z]+;|&#\d+;")
# A kind cell, and a §1 name cell, open with the name and may then annotate it.
# Requiring the whole cell meant `` `realm_delete` (new in 0.9) `` named no kind at
# all: the catalogue documented it, the enum lacked it, and both directions agreed.
# Applied with `.match`, which anchors at the start on its own -- a `^` here was a
# character no mutation could kill, because removing it changed nothing.
LEADING_CODE = re.compile(r"`([^`]+)`")
MAX_BYTES = 2 * 1024 * 1024


class InputError(ValueError):
    """Refusal of an input whose meaning the checker cannot safely determine."""


def read(path: Path) -> str:
    if not path.is_file():
        raise InputError(f"{path} is not a file")
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise InputError(f"{path} is larger than {MAX_BYTES} bytes")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InputError(f"{path} is not UTF-8: {exc}") from exc


def enum_kinds(contract: Path) -> list[str]:
    try:
        # S506 suppressed with reason: SAFE_LOADER resolves to `CSafeLoader` or
        # `SafeLoader`, never the arbitrary-object loader the rule is about. Ruff
        # reads the name, not what it is bound to, so it cannot see that.
        document = yaml.load(read(contract), SAFE_LOADER)  # noqa: S506
    except yaml.YAMLError as exc:
        # Left uncaught this escaped as a traceback at status 1, which reads as a
        # real disagreement between the documents. A merge-conflict marker or one
        # slipped indent lands here.
        raise InputError(f"{contract} is not valid YAML: {exc.__class__.__name__}") from exc
    try:
        enum = document["components"]["schemas"]["JobKind"]["enum"]
    except (KeyError, TypeError) as exc:
        raise InputError(f"{contract} has no JobKind enum") from exc
    if not isinstance(enum, list) or not all(isinstance(k, str) for k in enum):
        raise InputError(f"{contract}: JobKind's enum is not a list of strings")
    if not enum:
        raise InputError(f"{contract}: JobKind's enum is empty")
    return enum


def is_delimiter(line: str) -> bool:
    """The one line of a GFM table whose shape cannot be anything else.

    Every table has one, and it is what anchors a table here. Keying on a leading
    pipe instead was the hole that mattered most: GFM makes the **outer pipes
    optional on every row**, so a kind table written without them was read as
    fifteen kinds out of sixteen and reported as agreeing in both directions.
    """
    body = line.strip().lstrip(">").strip()
    return bool(body) and "|" in body and "-" in body and set(body) <= set("-:| \t")


def split_row(line: str) -> list[str]:
    r"""A table row's cells, outer pipes optional, `\|` kept as one cell."""
    body = line.strip().lstrip(">").strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    return [cell.replace("\\|", "|").strip() for cell in CELL.split(body)]


def visible(cell: str) -> str:
    """What a cell renders to, for the purpose of "is this filled in".

    `<!-- TODO decide -->` and `&nbsp;` each render to nothing a reader can see, and
    a plain emptiness test counted both as a timeout and as a compensation.
    """
    return COMMENT.sub("", ENTITY.sub("", cell)).strip()


def blanked(text: str) -> list[str]:
    """The lines, with code blocks blanked so examples are not read as data.

    Blanked rather than removed, so a line number still means the line it meant.
    Two kinds of block count: a fence, and an indented block, which is ordinary
    Markdown for an example and which the conservation rule below would otherwise
    refuse. An indented block cannot interrupt a paragraph, so it is recognised
    only after a blank line -- which is also what keeps a table indented INSIDE A
    LIST (two or three spaces, and not after a blank line) readable as a table.

    A third kind is an HTML block, which is not Markdown at all: a `###` line inside
    `<pre>` counted as a kind's section while the renderer showed no heading.

    An unclosed fence, or an unclosed HTML block, is refused. Left alone a fence
    blanks everything after it: one stray ``` under §2 took the scan from 96 steps to
    0, exit 0.
    """
    out: list[str] = []
    opener: str | None = None
    html_tag: str | None = None
    indented = False
    previous_blank = True
    for line in text.splitlines():
        blank = not line.strip()
        # An HTML block is not Markdown. A `###` line inside `<pre>` counted as a
        # kind's section while the renderer showed no heading at all, so a kind could
        # be "documented" by an example. Blanked like a fence, on the same reasoning,
        # and closed by its own tag.
        if html_tag is None and opener is None:
            opening = HTML_OPEN.match(line)
            if opening:
                html_tag = opening.group(1).lower()
                out.append("")
                previous_blank = False
                if f"</{html_tag}>" in line.lower():
                    html_tag = None
                continue
        elif html_tag is not None:
            closed = f"</{html_tag}>" in line.lower()
            out.append("")
            if closed:
                html_tag = None
            continue
        fence = FENCE.match(line)
        # A fence closes only on its OWN marker, and on one at least as long. A
        # single flag toggled by either marker meant a ``` line inside a ~~~ block
        # closed it and the next ~~~ opened a new one, leaving the document
        # "unclosed" -- a correct document, refused.
        if fence and opener is None:
            opener = fence.group(1)[0]
            out.append("")
            previous_blank = False
            continue
        if fence and opener is not None and fence.group(1)[0] == opener:
            opener = None
            out.append("")
            previous_blank = False
            continue
        if opener is not None:
            out.append("")
            continue
        if indented and not blank and not line.startswith("    "):
            indented = False
        if not indented and previous_blank and line.startswith("    ") and line.strip():
            indented = True
        out.append("" if indented else line)
        previous_blank = blank
    if opener is not None:
        raise InputError("a code fence is opened and never closed")
    if html_tag is not None:
        raise InputError(f"an HTML <{html_tag}> block is opened and never closed")
    return out


def tables(lines: list[str]) -> tuple[list[tuple[int, list[str], list[list[str]]]], set[int]]:
    """Every table, as (delimiter line index, header cells, body rows).

    Also the set of line indices consumed, so a caller can prove that every
    delimiter row in the text anchored a table rather than being passed over.
    """
    found: list[tuple[int, list[str], list[list[str]]]] = []
    consumed: set[int] = set()
    for index, line in enumerate(lines):
        if not is_delimiter(line):
            continue
        if index == 0:
            raise InputError("line 1 is a table delimiter row with no header above it")
        header = split_row(lines[index - 1])
        if len(header) != len(split_row(line)):
            # GFM requires the two to agree; where they do not, there is no table
            # and the rows below belong to nothing. Refusing beats guessing.
            raise InputError(
                f"line {index + 1}: a table's delimiter row has {len(split_row(line))} "
                f"cells and its header {len(header)}, so it is not a table"
            )
        consumed.update((index - 1, index))
        body: list[list[str]] = []
        cursor = index + 1
        while cursor < len(lines):
            nxt = lines[cursor]
            if not nxt.strip() or HEADING.match(nxt) or is_delimiter(nxt):
                break
            body.append(split_row(nxt))
            consumed.add(cursor)
            cursor += 1
        found.append((index, header, body))
    return found, consumed


def is_step_table(header: list[str]) -> bool:
    """A steps table is MARKED by its ordinal column, and validated separately.

    Recognising it by its whole header instead let one renamed column skip all of
    its rows silently; recognising it by a numeric first cell in a ROW refused a
    quota table a documentation author added under a kind. `#` is not a spelling a
    table about anything else uses.
    """
    return bool(header) and header[0] == STEP_MARKER


def section_bounds(lines: list[str]) -> tuple[int, int]:
    """The line range of §2, [start, end)."""
    start = next((i for i, line in enumerate(lines) if KINDS_SECTION.match(line)), None)
    if start is None:
        raise InputError("there is no '## 2.' section")
    end = next(
        (
            i
            for i, line in enumerate(lines[start + 1 :], start + 1)
            if line.startswith("## ") and not KINDS_SECTION.match(line)
        ),
        len(lines),
    )
    return start, end


def parse_catalogue(catalogue: Path) -> tuple[list[str], list[str], list[list[str]]]:
    """§2's ordered kinds, the headings under it, and its step rows."""
    try:
        lines = blanked(read(catalogue))
    except InputError as exc:
        raise InputError(f"{catalogue}: {exc}") from exc
    try:
        found, consumed = tables(lines)
    except InputError as exc:
        raise InputError(f"{catalogue}: {exc}") from exc
    start, end = section_bounds(lines)

    # Every delimiter row in the document is accounted for by `tables()`, which
    # either reads a table at it or refuses: a table the parser failed to read is
    # what vanished from the scan before, leaving only a smaller number in a summary
    # that nothing asserts. A separate conservation pass used to stand here and was
    # unreachable once the parser anchored on delimiters, so it is gone rather than
    # kept as a branch no case could own.
    #
    # A steps table outside §2 is a steps table nobody checks. Moving one under a
    # sibling `## 2bis` or `## 2.1` heading took four rows out of the scan, with an
    # undefined proof among them, and exited 0.
    for index, header, _ in found:
        if is_step_table(header) and not (start <= index < end):
            raise InputError(
                f"{catalogue}: line {index + 1} is a steps table outside §2, where "
                f"nothing reads it; move it under §2 or stop shaping it like one"
            )

    # Headings are read from the SAME blanked lines the tables come from. Read from
    # the raw text they were satisfied by a `###` line inside a code fence, so a
    # kind could be "documented" by an example.
    headings = [m.group(1) for m in (SUBSECTION.match(line) for line in lines[start:end]) if m]

    kinds: list[str] = []
    steps: list[list[str]] = []
    malformed: list[list[str]] = []
    for index, header, rows in found:
        if not start <= index < end:
            continue
        if header and header[0] == KIND_HEADER:
            for row in rows:
                named = LEADING_CODE.match(row[0]) if row else None
                if named is None:
                    raise InputError(
                        f"{catalogue}: a row of §2's '{KIND_HEADER}' table does not open "
                        f"with a back-ticked kind, so it names no kind: {row}"
                    )
                kinds.append(named.group(1))
        elif is_step_table(header):
            # The tail only. A header of the wrong WIDTH ending in the right word
            # needs no test here: every row under it then fails the row-width check
            # below, and a clause no case can own is not a clause.
            if header[-1] != STEP_TAIL:
                malformed.append(header)
            steps.extend(rows)
    if not kinds:
        raise InputError(f"{catalogue}: §2 has no table headed '{KIND_HEADER}'")
    if malformed:
        raise InputError(
            f"{catalogue}: a steps table header does not end in '{STEP_TAIL}', so its "
            f"rows could not be read: {malformed[0]}"
        )
    return kinds, headings, steps


def defined_names(catalogue: Path, after: str, header: str) -> set[str]:
    """The names in the first column of the table HEADED `header`, after a sentence.

    §1 defines the permitted idempotency proofs and retry classes as tables, so the
    permitted values are read from the document rather than duplicated here. A list
    copied into a checker stops agreeing with the document it checks.

    The table is found by its own header rather than by being the first one after
    the sentence. Inserting a clarifying table between the two made every real proof
    undefined -- 96 findings at status 1, when the cause was "I could not find the
    right table", which is status 2.
    """
    lines = blanked(read(catalogue))
    position = next((i for i, line in enumerate(lines) if after in line), None)
    if position is None:
        raise InputError(f"{catalogue}: §1 no longer says {after!r}")
    found, _ = tables(lines)
    for index, head, rows in found:
        if index > position and head and head[0] == header:
            names = set()
            for row in rows:
                named = LEADING_CODE.match(row[0]) if row else None
                if named is None:
                    # Skipped instead of refused, this was the widest hole here: an
                    # HTML comment flush against a table's last row ends the table in
                    # GFM while a line-based reader walks straight on, so a
                    # commented-out row was harvested as a definition and a retry
                    # class nobody had defined became legal. §2's kind table already
                    # refused exactly this shape; §1's tables did not.
                    raise InputError(
                        f"{catalogue}: a row of the '{header}' table after {after!r} "
                        f"does not open with a back-ticked name: {row}"
                    )
                names.add(named.group(1))
            if not names:
                raise InputError(f"{catalogue}: the '{header}' table after {after!r} names nothing")
            return names
    raise InputError(f"{catalogue}: no table headed '{header}' follows {after!r}")


def validate(
    enum: list[str],
    kinds: list[str],
    headings: list[str],
    steps: list[list[str]],
    proofs: set[str],
    retries: set[str],
) -> tuple[list[str], list[str]]:
    """Every disagreement found, and the kinds that are documented exactly once."""
    errors: list[str] = []
    documented: list[str] = []

    for kind in enum:
        if kind not in kinds:
            errors.append(f"JOB-LIST: JobKind has '{kind}'; §2 of {CATALOGUE} has no such kind")
    for kind in kinds:
        if kind not in enum:
            errors.append(f"JOB-LIST: §2 of {CATALOGUE} has '{kind}'; JobKind's enum has not")
    if not errors and enum != kinds:
        errors.append(
            f"JOB-LIST: the same kinds in a different order: JobKind reads {enum}, §2 reads {kinds}"
        )

    for kind in kinds:
        found = sum(1 for heading in headings if f"`{kind}`" in heading)
        if found == 1:
            documented.append(kind)
        else:
            errors.append(
                f"JOB-DOC: '{kind}' is named by {found} '###' headings under §2 of "
                f"{CATALOGUE}, not 1"
            )

    for row in steps:
        # `| # | Step | Proof | Timeout | Retry | Compensation |`. The outer
        # pipes are outside ROW's capture, so six columns give six cells.
        if len(row) != STEP_COLUMNS:
            errors.append(
                f"JOB-STEP: a step row under §2 has {len(row)} cells, not {STEP_COLUMNS}: {row}"
            )
            continue
        ordinal, step, proof, timeout, retry, compensation = row
        for label, value in (
            ("a proof", proof),
            ("a timeout", timeout),
            ("a retry class", retry),
            ("a compensation", compensation),
        ):
            if not visible(value):
                errors.append(f"JOB-STEP: step {ordinal} '{step[:40]}' names no {label}")
        claimed = CODE.findall(PARENTHETICAL.sub("", proof))
        for name in claimed:
            if name not in proofs:
                errors.append(
                    f"JOB-STEP: step {ordinal} claims the proof `{name}`, which §1 does not define"
                )
        if proof and not claimed:
            errors.append(
                f"JOB-STEP: step {ordinal} has '{proof[:40]}' in its proof cell, "
                f"which names no proof at all"
            )
        # The timeout cell is asserted present and nothing more. One real row
        # reads "remainder of the TTL", so a duration-shaped rule would have
        # made the document wrong where it is right: over-strict is a defect too.
        if retry and retry not in retries:
            errors.append(
                f"JOB-STEP: step {ordinal} claims the retry class {retry}, which §1 does not define"
            )

    return errors, documented


def main() -> int:
    args = sys.argv[1:]
    if len(args) > 2:
        print("usage: check-job-kind-catalogue.sh [contract] [catalogue]", file=sys.stderr)
        return 2
    contract = Path(args[0]) if args else CONTRACT
    catalogue = Path(args[1]) if len(args) > 1 else CATALOGUE
    try:
        enum = enum_kinds(contract)
        kinds, headings, steps = parse_catalogue(catalogue)
        proofs = defined_names(catalogue, "A step's idempotency proof is one of:", "Proof")
        retries = defined_names(catalogue, "**Retry policy classes.**", "Class")
    except InputError as exc:
        print(f"JOB-INPUT: {exc}", file=sys.stderr)
        return 2

    errors, documented = validate(enum, kinds, headings, steps, proofs, retries)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1

    print(
        f"{len(enum)} job kinds agree in both directions and in order; "
        f"{len(documented)} documented, {len(steps)} steps name a proof §1 defines "
        f"and a retry class §1 defines; step semantics and runtime behaviour unchecked"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

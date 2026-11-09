#!/usr/bin/env python3
"""Fail unreadable ADR statuses and ineligible ratification transitions.

`docs/adr/README.md` forbids editing an ADR after acceptance except to change
its **Status**. That makes the status the one field with a lifecycle, and it
makes a premature `Accepted` expensive: a contradiction merged inside an
accepted ADR can afterwards be corrected only by a whole superseding ADR.

A proposal first merges as `Proposed`. A separate status-only feature PR can
then be mechanically eligible for ratification under docs/dev/TESTING.md.
Eligibility proves the already-merged proposal and complete status-only diff;
it never certifies reviewer approval. Native protected review and current-head
merge gates remain the authorization boundary.

Four failures are caught here, all mechanical:

1. A status outside `Proposed`, `Accepted`, `Superseded by ADR-nnnn`, or an ADR
   whose header carries no status at all.
2. A changed `Accepted` ADR without status-only ratification eligibility.
3. An index row whose status disagrees with the ADR it links to, an ADR missing
   from an index, or an index row naming an ADR that does not exist. The
   registers are where a status is read from, so they carry the same fact and
   are checked against it rather than trusted.

   "The ADR it links to" was not true until the link was resolved. A row was
   bound to a decision by `os.path.basename` of its link, so the directory half
   was read and thrown away, and a row therefore never had to point at the ADR
   it reported on. `| [0001](../somewhere-else/0001-first-decision.md) | … |
   Proposed |` in `docs/adr/README.md` was accepted as the row for
   `docs/adr/0001-first-decision.md` while sending every reader who followed it
   to a different file, one saying `Accepted`, and the run printed "1 ADR
   statuses are valid and match every register". The same hole passed a plainly
   broken link: `adr/0001-…` written as `docs/adr/0001-…` resolves, from inside
   `docs/`, to `docs/docs/adr/0001-…`, which is nowhere — exit 0, same sentence.

   A row is now read where it sits. The two registers are at different depths
   and write the same ADR accordingly — `0001-profile-and-agent-contracts.md` from `docs/adr`,
   `adr/0001-profile-and-agent-contracts.md` from `docs` — so resolving each link against its
   own register's directory is the single rule that covers both, with neither
   named. The resolution is lexical (`normpath`, never `resolve()`): a row is
   bound to the path it is written as, because following a symlink here would
   hand a link outside `docs/adr` the identity of an ADR inside it, which is
   the second register-visible identity rule 4 refuses one function over.

   Deciding by directory also settled what the file name could not. Because
   `docs/INDEX.md` lists every document in the repository, a note at
   `notes/0001-kickoff-notes.md` used to be read as an ADR row and reddened
   this gate with an ADR message about a document that is not a decision. It
   does not resolve into `docs/adr`, so it is a row about some other document,
   which is what it always was. Nothing is skipped to buy that: a row that
   leaves `docs/adr` is still named when the register itself lives in
   `docs/adr` — every row of that one is about a decision there — or when the
   name it lands on is an ADR that does exist.

   None of that reached a row the *pattern* refused, and it refused four
   spellings a Markdown renderer follows straight to the ADR: a `#fragment`, a
   `?query`, `<angle brackets>`, and brackets around a fragment. `ROW_LINK`
   required a literal `.md` immediately before the closing parenthesis, so each
   of them missed and the row was dropped before any of the classification
   above ran. One such row appended to either register, reading `Accepted`
   beside a row reading `Proposed` for the same decision, exited 0 printing
   "4 ADR statuses are valid and match every register (on 'main')" — and where
   the unread row was the ADR's only one, the run said "no row in
   docs/INDEX.md, so its status is unpoliced there" about a register that row
   is plainly sitting in.

   The comment above that pattern is why this is a defect of its own and not a
   missing character. It said `[^)]+` was "deliberately wide" so that "this
   pattern has to see every row", and the tail requiring `.md` beside it was
   exactly the narrowing it denied. A reader auditing this file for the defect
   rule 4 exists for read a sentence promising it was not here.

   Both halves are fixed rather than the pattern alone. The narrowing is now
   stated — a path ending in `.md`, optionally in angle brackets, optionally
   with a fragment or a query — and it no longer hides anything: a row link
   outside those shapes is classified like any other, and one that names
   `docs/adr` fails saying so, instead of being passed over or reported as a
   missing row.

   And the sentence that said so was itself the next defect, for the same
   reason and one syntax over. It read "nothing the narrowing excludes is
   dropped", naming `UNREAD_LINK` as what caught the excluded rows — but
   `UNREAD_LINK` is anchored on `](`, and CommonMark's *other* link syntax
   carries none. A reference link names a label and keeps the destination in a
   definition elsewhere in the file:

       [adr1]: 0001-profile-and-agent-contracts.md
       | [0001][adr1] | Profile and agent contracts | Accepted |

   `ROW_LINK` found nothing, `UNREAD_LINK.findall` returned an empty list, its
   loop body never ran, and the row left through a bare `continue`. On this
   repository's own registers, unmodified check, on the trunk, that pair exited
   0 printing "4 ADR statuses are valid and match every register (on 'main')"
   beside the correct `Proposed` row — and rendered with tables on, the two rows
   emit the identical `<a href="0001-profile-and-agent-contracts.md">`. Three spellings escaped
   per register, because CommonMark resolves three: `[text][label]`,
   `[label][]` and `[label]`. Where such a row was the decision's only one, the
   run said "no row in docs/adr/README.md, so its status is unpoliced there" —
   verbatim the sentence the paragraph above added `refuse_unread_link` to stop
   saying, said again through the syntax that paragraph did not cover.

   So the reading is by *shape a renderer resolves*, not by punctuation this
   file happens to look for. Definitions are read per register — the same rule
   as resolving a link against its own register's directory — labels are matched
   the way CommonMark matches them, and a resolved reference row is handed to
   the classification above unchanged, so a register cannot buy a different
   verdict by changing link syntax. Two shapes are decided rather than read, and
   both are decided loudly: raw HTML (`refuse_html_anchor`) and an undefined
   label in the two unambiguous reference shapes (`reference_target`).
4. **Any** entry in `docs/adr/` that is not an ADR, the template or the
   register. Three versions of this check narrowed the directory before reading
   it and called what fell outside the narrowing "not there". `glob("*.md")`
   with a `continue` on an unmatched name hid `0009-Realm_Topology.md`,
   `00010-...` and `docs/adr/drafts/`; `rglob("*.md")` closed those and left
   four more, because the pattern still decided what counted as an entry:
   `0009-ninth-decision` with no extension, `.markdown`, `.txt`, and a
   *symlinked* subdirectory, which `rglob` will not walk into. All four exited
   0 printing "1 ADR statuses are valid and match every register" — the exact
   sentence this rule exists to prevent.

   So the directory is now listed, not searched: `iterdir()` over
   `docs/adr` and a decision on every entry, in this order — a symbolic link
   fails, a directory fails, anything that is not a regular file fails, the
   template and the register are the two names skipped, a name matching
   `ADR_NAME` is an ADR, and everything else fails. Nothing is filtered before
   the classification, so there is no pattern left for an entry to sit outside
   of. A symlink fails even when its name and its target are both valid, since
   it is a second register-visible identity for a decision that already has
   one: a link named `0009-…` at `0001-…` scanned as a ninth decision and the
   run reported two.

   `ADR_NAME` was the last way through, because a classification is only ever
   as narrow as the pattern it ends on. Its four digits were matched by the
   Unicode-aware digit class while the slug beside them was ASCII, so four
   digits from any script bought a second name for one decision number:
   `٠٠٠٩-ninth-decision.md` beside `0009-ninth-decision.md`, both listed in
   both registers, both reading `| [0009](…) |` to a human, and the run printed
   "3 ADR statuses are valid and match every register". N'Ko and fullwidth
   digits did the same. Both places that read a number are now `[0-9]`.

The branch comes from `GITHUB_REF_NAME` and the changed files from stdin, so
ordinary status checks use the interpreter; ratification also reads local Git evidence:

    git diff --name-only origin/main...HEAD \
      | python3 .github/scripts/check-adr-status.py --changed-on-stdin

Off the trunk without `--changed-on-stdin` the check refuses to run rather than
guess. A caller who forgets the pipe would otherwise be told that a branch full
of prematurely accepted ADRs is fine, which is the failure this exists to
prevent. On the trunk, rule 2 does not apply and no list is needed.

Two callers run it: `make adr` on a laptop, and the `adr-status` job in
`.github/workflows/ci.yml`, which is listed in the `ci-ok` aggregate so that a
skip cannot read as a pass. Both run the self-test beside this file first, on
the same rule as every other gate here: a check nobody has watched fail is a
decoration.
"""

import os
import posixpath
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Main is already merged; feature refs require explicit ratification eligibility.
TRUNK = "main"
BASE_REF = "refs/remotes/origin/main"

ADR_DIR = Path("docs/adr")
TEMPLATE = "0000-template.md"
REGISTER = "README.md"

# Registers that restate an ADR's status. A stale row here is read by humans as
# the truth, so it is a status defect wherever it sits.
INDEXES = (Path("docs/adr/README.md"), Path("docs/INDEX.md"))

# `0000-template.md` and the register's own `README.md` are excluded by name
# below; the template documents the alternation rather than carrying a status.
#
# The digits are `[0-9]`, not `\d`. `\d` is Unicode-aware, so `\d{4}` admitted any
# four characters of category Nd while the slug half `[a-z0-9-]` stayed ASCII:
# two halves of one pattern disagreeing, with the wide half deciding which
# entries become policed ADRs. `٠٠٠٩-ninth-decision.md` beside
# `0009-ninth-decision.md`, both listed in both registers, both rendering to a
# reader as `| [0009](…) |`, were scanned as two decisions and the run printed
# "3 ADR statuses are valid and match every register"; N'Ko `߀߀߀߉` and fullwidth
# `０００９` did the same. That is the second register-visible identity a symlink
# is refused for above, arriving through the name instead.
#
# `[0-9]` rather than the `re.ASCII` flag, for two reasons. This pattern is
# printed to the reader in both messages below, so the set it names has to be
# the set it accepts — under a flag `.pattern` still reads `\d{4}` while the
# check behaves as `[0-9]{4}`, which is a message asserting something other
# than what ran, the defect this file exists to argue against. And the fix has
# to be per-pattern: `ADR_SHAPED` below must stay Unicode-wide, so a module-wide
# flag applied for tidiness would close this hole and open that one.
ADR_NAME = re.compile(r"^([0-9]{4})-[a-z0-9-]+\.md$")

# Said once, so the message and the rule cannot drift apart.
ADR_NAME_RULE = "four digits, a hyphen, then lower-case letters, digits and hyphens, then '.md'"

# A name that is trying to be an ADR and failing: four-plus digits, then a
# separator. It is read for one question only — a row that already resolves
# into `docs/adr` and whose name `ADR_NAME` refuses: "a decision whose name is
# wrong" or "some other file named in that directory". Whether a row is about
# an ADR at all is settled a step earlier, by the directory its link resolves
# to, and never by the name at the end of the link.
#
# `\d` here is deliberate, and the one place in this file where the wide class is
# the right one: this pattern decides whether a row `ADR_NAME` rejected gets
# *named* or gets passed over. It therefore has to stay at least as wide as
# `ADR_NAME`, so that the spellings `ADR_NAME` now refuses are reported instead
# of skipped. Narrowing it to `[0-9]` for symmetry would reopen on the register
# side exactly the hole `[0-9]{4}` closes on the file side.
# `index-row-unicode-digits` in the self-test holds it open.
ADR_SHAPED = re.compile(r"^\d+[-_]")

# The header is a fixed shape. A status further down the file is prose.
#
# `\s` is left Unicode-aware. It is safe because this pattern only locates the
# status and strips its padding: what it captures is then compared for exact
# equality against `KNOWN` and `SUPERSEDED`, so a wider `\s` cannot admit a
# status value a narrower one would refuse — it can only trim a space a reader
# already sees as a space. Nor can it hide one: an ADR whose status this cannot
# read raises, and a raise here is an error, never a file quietly skipped.
HEADER_LINES = 12
STATUS_LINE = re.compile(r"^\*\*Status:\*\*\s*(.+?)\s*$")

# The second site of the defect above, found by sweeping the rest of the file
# for it: `\d{4}` beside the ASCII literal `Superseded by ADR-` accepted
# `Superseded by ADR-٠٠٠٩` as a valid status, on the ADR and in both registers,
# exit 0. A successor number that no ADR file name can now carry is a
# supersession pointing at a decision which cannot exist, while reading to a
# human as `ADR-0009`.
SUPERSEDED = re.compile(r"^Superseded by ADR-[0-9]{4}$")
KNOWN = ("Proposed", "Accepted")
ALLOWED = "Proposed, Accepted, or Superseded by ADR-nnnn"

# A table row links to the ADR it reports on. Prose that happens to link to an
# ADR does not start with a pipe, so it is not read as a row.
#
# This pattern **is** a narrowing, and the previous version of this comment said
# the opposite: that `[^)]+` "carries no character-class escape and is
# deliberately wide", so every row reached the classification below. The `\.md\)`
# tail was the narrowing, and it decided what counted as a row before anything
# had classified it — the defect rule 4 exists for, occurring in the check for
# it, with a sentence above it asserting the property the line lacked, which is
# worse than the line alone: a reader looking for this hole read a promise that
# it was not there. `](0001-…md#status)`, `](0001-…md?plain=1)`, `](<0001-…md>)`
# and `](<0001-…md#status>)` are four spellings a Markdown renderer follows
# straight to the ADR. Each was dropped without a word: a row reading `Accepted`
# appended beside a row reading `Proposed`, in either register, exited 0 printing
# "4 ADR statuses are valid and match every register (on 'main')".
#
# So the narrowing is stated instead. A row link is a path ending in `.md`,
# optionally wrapped in `<angle brackets>` and optionally carrying a `#fragment`
# or `?query`. That is every **inline** shape — `](destination)` — and the
# previous version of this sentence claimed it was every shape either register
# "may write for a document in this repository", which was the wider claim and
# the false one: CommonMark's other link syntax, the reference link, carries no
# `](` at all, and `REFERENCE_LINK` below is where those are read. `[^)>#?]`
# excludes exactly the three characters that end the path: `#` and `?` begin the
# parts of a URL that are not the path, and `>` closes the angle-bracket form.
#
# The angle brackets are a **pair**, which `(?(1)>)` is doing: a `>` is required
# only when a `<` opened, and refused when none did. Written as the looser
# `<?…>?`, one character shorter, the pattern reads `](<0001-…md)` as the ADR —
# a destination CommonMark does not close, so it renders as text and links a
# reader nowhere — and reads `](0001-…md>)` as the ADR while a renderer follows
# it to a file called `0001-…md>`. The first of those is a shape the `[^)]+`
# version caught, by capturing the `<` and landing outside `docs/adr`, so the
# loose form would have bought four spellings at the price of one already held.
# Both are unread here and named by the rule below instead.
#
# What the narrowing excludes is answered for by name, and the previous version
# of this sentence said "nothing the narrowing excludes is dropped" while naming
# only `UNREAD_LINK` — which is itself anchored on `](`. A row carrying no `](`
# reached neither: `ROW_LINK` found nothing, `UNREAD_LINK.findall` returned an
# empty list, its loop body never ran, and the row was passed over by a bare
# `continue`. A reference-link row is exactly that row, so the sentence promising
# it could not happen sat above the line that let it. Three paths now divide
# every row of a register between them, and each says something:
#
#   * `ROW_LINK` reads the inline shape.
#   * `REFERENCE_LINK` with `LINK_DEFINITION` reads the three reference shapes.
#   * `HTML_ANCHOR` refuses raw HTML outright.
#
# and `UNREAD_LINK` names what is left holding a `](` it cannot read. The
# classification is still what decides whether a row is about a decision; these
# patterns only decide whether the check can read the row at all, and each says
# so when it cannot.
ROW_LINK = re.compile(r"\]\((<)?([^<>)#?]+\.md)(?:[#?][^<>)]*)?(?(1)>)\)")

# `ROW_LINK` group 2 — group 1 is the opening angle bracket, which exists only
# to be required back by `(?(1)>)`. Named, because "group 1 is the path" is the
# kind of thing that stays true in a reader's head after it has stopped being
# true in the pattern.
ROW_LINK_PATH = 2

# Whatever sits between `](` and the next `)`, read only when `ROW_LINK` has
# already refused the line. It exists so that "this row is about some other
# document" and "this row is about an ADR and I cannot read it" stop being the
# same silence. Without it the second case surfaced, at best, as
# "no row in docs/INDEX.md, so its status is unpoliced there" — a sentence
# pointing the reader at a register to look for a row that is plainly in it.
UNREAD_LINK = re.compile(r"\]\(([^)]*)")

# CommonMark's other link syntax. A reference link names a label and the
# destination sits elsewhere in the file, so the row carries no `](` and every
# pattern above it missed the row entirely rather than refusing it.
#
# `[label]: destination`, at most three spaces in, optionally with a title. Only
# the destination is read: a title changes nothing about where the link goes, and
# it may be written three ways and may sit on the following line, so reading it
# would be surface with no question behind it. What the title cannot do is move
# the destination, which is why taking the first token after the colon is enough
# for every titled form at once.
LINK_DEFINITION = re.compile(r"^ {0,3}\[([^\[\]]+)\]:[ \t]*(.*)$")

# The destination itself: `<angle brackets>` may hold spaces, a bare one may not.
LINK_DESTINATION = re.compile(r"^(?:<([^<>]*)>|(\S+))")

# The three reference shapes in one pattern, scanned left to right so that a
# full reference consumes both of its bracket runs. Read as alternatives on the
# second group: `[text][label]` is full, `[label][]` is collapsed, and a bracket
# run followed by neither `[` nor `(` is a shortcut. The `(?![\[(])` is what
# keeps `[text](destination)` out — that is the inline shape, which `ROW_LINK`
# owns and which must not be read twice under two rules.
REFERENCE_LINK = re.compile(r"\[([^\[\]]*)\](?:\[([^\[\]]*)\]|(?![\[(]))")

# Raw HTML in a register row. Refused rather than read; `refuse_html_anchor`
# below carries the reasoning. `<a` alone would match `<abbr`, so the tag has to
# end where a tag name ends.
HTML_ANCHOR = re.compile(r"<a[\s>]", re.IGNORECASE)


def fold_label(label):
    """A link label, folded the way CommonMark matches one.

    Case-insensitive, and internal whitespace counts as one space, so `[ADR
    One]` and `[adr one]` are the same label to a renderer and have to be the
    same label here. This is the one place a Unicode-wide rule is the correct
    one — `casefold` and `str.split`, not an ASCII narrowing — for the same
    reason `ADR_SHAPED` is wide: narrowing it would make a label a renderer
    resolves fail to match its definition here, and an unmatched label in the
    shortcut shape is a row read by nothing. Wide here, narrow at `ADR_NAME`;
    the direction that keeps a row *read* is the one to take in both places.
    """
    return " ".join(label.split()).casefold()


class ReadError(Exception):
    """Something at ADR or row shape that the scanner could not read.

    Raised rather than skipped: a row this check cannot parse is a row whose
    status it would otherwise silently declare correct.
    """


def status_of(path):
    """Return (status, line number) from an ADR header."""
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, line in enumerate(lines[:HEADER_LINES], start=1):
        found = STATUS_LINE.match(line)
        if found:
            return found.group(1), number
    raise ReadError(
        f"no '**Status:**' line in the first {HEADER_LINES} lines; "
        f"every ADR states its status in its header"
    )


def valid(status):
    """Is this one of the three statuses the register allows?"""
    return status in KNOWN or bool(SUPERSEDED.match(status))


def adr_files(root):
    """Return ({file name: path}, [(path, why)]) for `docs/adr`.

    The second list is the point. Everything in this directory is an ADR, the
    template or the register; anything else is a decision nobody is policing,
    and it must be said out loud rather than skipped.

    The directory is **listed**, never searched by pattern. A glob decides what
    counts as an entry before anything has classified it, so whatever the
    pattern misses is not reported missing — it is not reported at all. Every
    entry `iterdir` yields therefore lands in exactly one branch below, and the
    last branch is a failure rather than a `continue`.
    """
    found, strays = {}, []
    directory = root / ADR_DIR
    if not directory.is_dir():
        return found, strays

    def stray(path, why):
        strays.append((path, why))

    for path in sorted(directory.iterdir()):
        name = path.name

        # First, because `is_dir()` and `is_file()` both follow the link and
        # would answer for the target instead of for what sits in `docs/adr`.
        if path.is_symlink():
            stray(
                path,
                f"'{name}' in {ADR_DIR} is a symbolic link. An ADR is a file in "
                f"this directory, not a link to one: a link to a decision is a "
                f"second register-visible identity for it, and a link to a "
                f"directory is a place this check cannot follow. Replace it with "
                f"the file, or move it out of this directory",
            )
        elif path.is_dir():
            stray(
                path,
                f"'{name}' is a directory inside {ADR_DIR}. An ADR lives directly "
                f"in {ADR_DIR} and is listed in both registers; a decision parked "
                f"in a subdirectory is unpoliced",
            )
        elif not path.is_file():
            stray(
                path,
                f"'{name}' in {ADR_DIR} is not a regular file, so there is no "
                f"status in it to read. Remove it, or move it out of this "
                f"directory",
            )
        elif name in (TEMPLATE, REGISTER):
            continue
        elif not ADR_NAME.match(name):
            stray(
                path,
                f"'{name}' is in {ADR_DIR} but is not an ADR file name. "
                f"The rule is {ADR_NAME.pattern} — {ADR_NAME_RULE}. Rename it, "
                f"or move it out of this directory; it is not checked while it "
                f"is neither",
            )
        else:
            found[name] = path
    return found, strays


def row_target(register, link):
    """Where a register row's link lands, read from the register's directory.

    A Markdown link is relative to the file holding it, so the two registers
    write one ADR two ways — `0001-profile-and-agent-contracts.md` from `docs/adr`,
    `adr/0001-profile-and-agent-contracts.md` from `docs` — and both name the same path.
    Resolving against `register.parent` is therefore one rule for both depths,
    rather than a rule per register that a third register would escape.

    Lexical on purpose: `normpath`, not `resolve()`. A row is bound to the path
    it is written as. `resolve()` would follow a symlink and let a link from
    outside `docs/adr` acquire the identity of an ADR inside it, which is the
    second register-visible identity `adr_files` refuses.
    """
    # Inline parsing already separates decorations; reference definitions do
    # not. Both must identify the file before resolving its register-relative path.
    link = link.split("#", 1)[0].split("?", 1)[0]
    return posixpath.normpath(posixpath.join(register.parent.as_posix(), link))


def about_adr_dir(register, adrs, target):
    """Why a row landing on `target` is a row about a decision, or None.

    The one place this question is answered, so the branch that reads a row and
    the branch that cannot read one classify it the same way. A row is about a
    decision when it lands in `docs/adr`, when the register holding it is the
    one inside `docs/adr` — every row of that one is about a decision there —
    or when the name it lands on is an ADR that exists.
    """
    if posixpath.dirname(target) == ADR_DIR.as_posix():
        return f"'{target}' is in {ADR_DIR}"
    if register.parent == ADR_DIR:
        return f"every row in the register inside {ADR_DIR} is about a decision there"
    if posixpath.basename(target) in adrs:
        return f"'{posixpath.basename(target)}' is an ADR in {ADR_DIR}"
    return None


def refuse_unread_link(register, adrs, number, line):
    """Fail on a row link `ROW_LINK` refused which still names a decision.

    `ROW_LINK` narrows, so something has to answer for what it excludes, or the
    narrowing is the silent drop it replaced. A row it cannot read is passed to
    the same classification a readable one gets, on the path the link is written
    as with its angle brackets, fragment and query taken off; a row about some
    other document is still skipped, and a row about a decision is a failure
    naming the link rather than a row nobody hears about again.

    This is also where the wrong sentence was said. An unread link left the ADR
    out of `listed`, so `check_indexes` reported "no row in <register>, so its
    status is unpoliced there" about a register whose row for it is right there
    — a reader sent to add a row that already exists. The register is not
    missing a row; the link in it is written in a shape a row link is not read
    in, and that is what is said now.
    """
    for written in UNREAD_LINK.findall(line):
        path = written.strip("<>").split("#", 1)[0].split("?", 1)[0].strip()
        why = about_adr_dir(register, adrs, row_target(register, path))
        if why is None:
            continue
        raise ReadError(
            f"{register}:{number}: this row links to '{written}', and a row "
            f"link is not read in that shape: it is a path ending in '.md', "
            f"optionally wrapped in <angle brackets> and optionally followed by "
            f"a '#fragment' or a '?query'. This row is an ADR row — {why} — so "
            f"it is not a row about some other document to pass over. Its "
            f"status was read by nothing. Rewrite the link, or take the row out "
            f"of this register"
        )


def link_definitions(text):
    """Return {folded label: destination} for one register's whole text.

    Definitions are per-file, which is what makes reading them here — from the
    text the caller already read for its rows — the same rule as resolving a
    link against its own register's directory: one register's labels never
    reach the other's rows.

    Two spellings a line-at-a-time reader would miss are handled, because both
    are shapes a renderer resolves and this file's whole subject is a link a
    renderer follows and the check does not. A destination may sit on the line
    after the colon, and a title may follow the destination or sit on its own
    line. Only the destination is kept, so both fall out of the same rule: take
    the first token after the colon, and if there is none, take the first token
    of the next non-blank line.
    """
    definitions = {}
    lines = text.splitlines()
    for index, line in enumerate(lines):
        found = LINK_DEFINITION.match(line)
        if not found:
            continue
        label, rest = found.group(1), found.group(2).strip()
        if not rest:
            for following in lines[index + 1 :]:
                if following.strip():
                    rest = following.strip()
                    break
        destination = LINK_DESTINATION.match(rest)
        if not destination:
            continue
        # A label already defined keeps its first definition, as CommonMark says.
        definitions.setdefault(fold_label(label), destination.group(1) or destination.group(2))
    return definitions


def refuse_html_anchor(register, number, line):
    """Fail on a register row that links in raw HTML rather than in Markdown.

    `<a href="0001-…md">` renders to the same `<a>` element the Markdown row
    beside it renders to, so it is a row that reports a status and links to a
    decision, and it holds no `](` and no bracket run: every pattern here misses
    it. That leaves two options, and refusing is the one taken.

    Reading it would mean an HTML attribute parser — single quotes, unquoted
    values, character references, an `href` after other attributes — and each
    spelling it did not cover would land in the branch that decides "this row is
    about some other document" and be dropped in silence. That is the failure
    this whole file is a record of, bought a second time to support a shape
    neither register uses. Refusing needs no parser and leaves no residue: the
    rule is total, it is stated in the message, and it cannot be escaped by
    writing the href differently.

    It refuses whatever the anchor points at, deliberately. Deciding first
    whether the row is about a decision would mean reading the `href` — the
    parser just refused — and reading it partially is worse than not reading it
    at all, because an `href` this file failed to decode would be classified as
    "some other document" and passed over. Both registers are Markdown tables
    written in Markdown links, so the rule costs them nothing.
    """
    if HTML_ANCHOR.search(line):
        raise ReadError(
            f"{register}:{number}: this row links in raw HTML. A register row "
            f"links to the document it reports on with a Markdown link — "
            f"'[text](path.md)', or a reference link whose label is defined in "
            f"this file — because that is the one shape this check reads, and a "
            f"row it does not read is a row whose status nothing compares. "
            f"Rewrite the link in Markdown, or take the row out of this register"
        )


def reference_target(register, definitions, number, line):
    """The destination of a row's reference link, or None if it has none.

    CommonMark's three reference shapes, all read here because a renderer emits
    the same `<a href>` for all three and for the inline shape beside them:

        full        [text][label]
        collapsed   [label][]
        shortcut    [label]

    A **defined** label in any of the three is a link, and the destination it
    resolves to is handed back to be classified exactly as an inline one is —
    same directory resolution, same `about_adr_dir`, same messages. Nothing
    downstream knows which shape the row was written in, which is the point: a
    register cannot buy a different verdict by changing link syntax.

    An **undefined** label divides, and the division is CommonMark's, not a
    convenience. `[text][label]` and `[label][]` cannot be anything but a link
    attempt, so an undefined label there is a broken row in a register — it
    renders as literal text, sends its reader nowhere, and its status was
    compared against nothing. It is refused, in either register and whatever the
    label spells, because there is no destination to ask `about_adr_dir` about
    and guessing one from the label would be a guess. A correct register has
    none of these, so the rule costs nothing to obey.

    A bare `[label]` is the opposite: undefined, it is not a link at all but a
    bracketed word, which prose and table cells contain for their own reasons.
    Reddening this gate on those is how a gate gets switched off, so an
    undefined shortcut is passed over — and it is not the silence this commit
    exists to end, because a row that links nowhere is not a row reporting on a
    decision, and an ADR whose only row is one gets the missing-row failure,
    which by then says something true.
    """
    for found in REFERENCE_LINK.finditer(line):
        first, second = found.group(1), found.group(2)
        shortcut = second is None
        label = first if shortcut or not second else second
        if not label.strip():
            continue
        destination = definitions.get(fold_label(label))
        if destination is not None:
            return destination
        if shortcut:
            continue
        raise ReadError(
            f"{register}:{number}: this row links to '[{label}]', and no "
            f"'[{label}]: <path>' definition in this file gives that label a "
            f"destination. A reference link with no definition renders as "
            f"literal text, so the row links its reader nowhere and its status "
            f"was read by nothing. Define the label, write the link inline, or "
            f"take the row out of this register"
        )
    return None


def index_rows(register, adrs, text):
    """Return [(line number, ADR file name, status)] for one register.

    `register` is the repository-relative path, because it is what the links in
    it are relative to; `text` is its content, read by the caller.
    """
    rows = []
    definitions = link_definitions(text)
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.startswith("|"):
            continue
        # Before any link is looked for, because a row written in raw HTML
        # carries neither `](` nor a bracket run and would otherwise reach none
        # of the three refusals below.
        refuse_html_anchor(register, number, line)
        link = ROW_LINK.search(line)
        if link:
            written = link.group(ROW_LINK_PATH)
        else:
            # Never a bare `continue`: a row the inline pattern refuses is
            # classified like any other before it is passed over, and one about
            # a decision fails here instead of vanishing. `refuse_unread_link`
            # first, because it is the narrower question — it speaks only for a
            # row already holding a `](` it cannot read — and a row holding both
            # an unreadable inline link and a reference link must not have the
            # first one covered up by the second one resolving.
            refuse_unread_link(register, adrs, number, line)
            written = reference_target(register, definitions, number, line)
            if written is None:
                continue
        target = row_target(register, written)
        name = posixpath.basename(target)

        if posixpath.dirname(target) != ADR_DIR.as_posix():
            # The link leaves `docs/adr`. Whether that is a defect or a row
            # about some other document is decided here, by where the row
            # points, and never by the name at the end of it — that is what
            # `os.path.basename` decided, and it let a row report on an ADR it
            # did not point at. A row is still named rather than skipped when
            # the register indexes `docs/adr` itself, or when it lands on the
            # name of an ADR that exists.
            why = about_adr_dir(register, adrs, target)
            if why is None:
                continue
            wanted = posixpath.relpath(
                posixpath.join(ADR_DIR.as_posix(), name), register.parent.as_posix()
            )
            raise ReadError(
                f"{register}:{number}: this row links to '{written}', which "
                f"resolves to '{target}' — a row is read from its own "
                f"register's directory, '{register.parent}'. That is not a "
                f"file in {ADR_DIR}, and this row is an ADR row: {why}. Point "
                f"it at '{wanted}', or take the row out of this register"
            )

        if name in (TEMPLATE, REGISTER):
            continue
        if not ADR_NAME.match(name):
            # Same hole as `adr_files` had, one file over: a row pointing at
            # `0009-Realm_Topology.md` was skipped, so a register could name a
            # decision that neither exists nor is checked.
            if ADR_SHAPED.match(name):
                raise ReadError(
                    f"{register}:{number}: this row links to '{name}', which is not an "
                    f"ADR file name ({ADR_NAME.pattern}). Either the file is "
                    f"misnamed or this row is"
                )
            continue

        # The two registers order their columns differently, so the status is
        # found by what it says rather than by where it sits. Zero or several
        # candidates is a parse failure, never a row quietly passed over.
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        statuses = [cell for cell in cells if valid(cell)]
        if len(statuses) != 1:
            raise ReadError(
                f"{register}:{number}: cannot tell which cell is the status of "
                f"{name}; expected exactly one cell reading {ALLOWED}"
            )
        rows.append((number, name, statuses[0]))
    return rows


def changed_adrs(adrs, raw):
    """ADR file names named by the piped `git diff --name-only` output."""
    changed = set()
    for line in raw.splitlines():
        entry = line.strip()
        if not entry:
            continue
        try:
            relative = Path(entry).relative_to(ADR_DIR)
        except ValueError:
            continue
        if relative.name in adrs:
            changed.add(relative.name)
    return changed


def error(path, message, line=None):
    where = f"file={path}" + (f",line={line}" if line else "")
    print(f"::error {where}::{message}")


def check_statuses(adrs):
    """Rule 1. Returns (statuses by file name, failure count)."""
    statuses, failures = {}, 0
    for name, path in adrs.items():
        try:
            status, line = status_of(path)
        except ReadError as exc:
            error(path, str(exc))
            failures += 1
            continue
        statuses[name] = status

        if not valid(status):
            error(path, f"status {status!r} is not one of: {ALLOWED}", line)
            failures += 1
            continue

    return statuses, failures


def check_indexes(root, adrs, statuses):
    """Rule 3. Every register agrees with every ADR file, both ways."""
    failures = 0
    for relative in INDEXES:
        path = root / relative
        if not path.is_file():
            error(relative, "register is missing; ADR statuses have no index")
            failures += 1
            continue

        try:
            rows = index_rows(relative, adrs, path.read_text(encoding="utf-8"))
        except ReadError as exc:
            error(relative, str(exc))
            failures += 1
            continue

        listed = set()
        for line, name, status in rows:
            listed.add(name)
            if name not in adrs:
                error(relative, f"row names {name}, which is not in {ADR_DIR}", line)
                failures += 1
            elif name in statuses and status != statuses[name]:
                error(
                    relative,
                    f"this register says {name} is {status!r}; the file says {statuses[name]!r}",
                    line,
                )
                failures += 1

        for name in sorted(set(adrs) - listed):
            error(adrs[name], f"no row in {relative}, so its status is unpoliced there")
            failures += 1
    return failures


def git_evidence(root, *args):
    """Read local history; never fetch, choose a caller-supplied base, or mutate."""
    executable = shutil.which("git")
    if executable is None:
        raise ReadError("cannot read ratification Git evidence: Git is unavailable")
    try:
        # Fixed internal Git operations with separate arguments, never a shell.
        return subprocess.run(  # noqa: S603
            [executable, "--no-replace-objects", "-C", str(root), *args],
            check=True,
            capture_output=True,
            timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReadError("cannot read ratification Git evidence") from exc


def unique_status(text, path):
    """Locate the sole status value without normalizing any bytes around it."""
    lines = text.splitlines(keepends=True)
    found = [(i, STATUS_LINE.fullmatch(line.rstrip("\r\n"))) for i, line in enumerate(lines)]
    found = [(i, match) for i, match in found if match]
    markers = [line for line in lines if line.lstrip().startswith("**Status:**")]
    if len(markers) != 1 or len(found) != 1 or found[0][0] >= HEADER_LINES:
        raise ReadError(f"{path}: ratification requires exactly one status line in the header")
    index, match = found[0]
    offset = sum(map(len, lines[:index]))
    return match.group(1), offset + match.start(1), offset + match.end(1)


def ratification_base(root):
    if (
        Path(git_evidence(root, "rev-parse", "--show-toplevel").decode().strip()).resolve()
        != root.resolve()
    ):
        raise ReadError("ratification root must be the actual Git repository root")
    if git_evidence(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ReadError("ratification requires a clean committed working tree")
    base = git_evidence(root, "rev-parse", "--verify", f"{BASE_REF}^{{commit}}").decode().strip()
    head = git_evidence(root, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    # Local replacement objects and shallow history must not manufacture proof.
    if git_evidence(root, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise ReadError("ratification requires complete history")
    try:
        git_evidence(root, "merge-base", "--is-ancestor", base, head)
    except ReadError as exc:
        raise ReadError("current main base must be an ancestor of HEAD") from exc
    return base, head


def check_ratification(root, adrs, statuses, changed):
    """Rule 2: prove eligibility only; review authority stays outside this check."""
    if "Accepted" not in statuses.values():
        return 0
    try:
        base, head = ratification_base(root)
        # --raw -z gives path boundaries and file modes without quoted names.
        raw = git_evidence(root, "diff", "--raw", "-z", "--no-renames", base, head, "--").split(
            b"\0"
        )
        changes = dict(zip(raw[1:-1:2], raw[0:-1:2], strict=True))
        paths = {path.decode() for path in changes}
        actual_changed = changed_adrs(adrs, "\n".join(paths))
        if changed != actual_changed:
            raise ReadError("changed ADR input does not match pinned Git diff")
        candidates = {name for name in actual_changed if statuses.get(name) == "Accepted"}
        if not candidates:
            return 0
        expected_paths = {str(ADR_DIR / name) for name in candidates} | {str(p) for p in INDEXES}
        if paths != expected_paths:
            raise ReadError(
                "entire ratification diff must contain only candidate ADRs and both registers"
            )
        for metadata in changes.values():
            fields = metadata.split()
            if fields[0] != b":100644" or fields[1] != b"100644" or fields[-1] != b"M":
                raise ReadError("only existing regular files may be modified during ratification")

        def before(path):
            return git_evidence(root, "show", f"{base}:{path}").decode("utf-8")

        base_statuses = {}
        for name in sorted(adrs):
            path = ADR_DIR / name
            original = before(path)
            status, start, end = unique_status(original, path)
            base_statuses[name] = status
            if name not in candidates:
                continue
            if status != "Proposed":
                raise ReadError(f"{path}: base status must be Proposed")
            current = git_evidence(root, "show", f"{head}:{path}").decode("utf-8")
            unique_status(current, path)
            if current != original[:start] + "Accepted" + original[end:]:
                raise ReadError(f"{path}: only the unique status value may change")

        for register in INDEXES:
            original = before(register)
            rows = index_rows(register, adrs, original)
            names = [name for _, name, _ in rows]
            if set(names) != set(adrs) or len(names) != len(set(names)):
                raise ReadError(f"{register}: base register must contain exactly one row per ADR")
            lines = original.splitlines(keepends=True)
            for number, name, status in rows:
                if status != base_statuses[name]:
                    raise ReadError(f"{register}: base register disagrees with its ADR")
                if name in candidates:
                    cells = lines[number - 1].split("|")
                    positions = [i for i, cell in enumerate(cells) if valid(cell.strip())]
                    if len(positions) != 1:
                        raise ReadError(f"{register}: ambiguous base register status cell")
                    i = positions[0]
                    cells[i] = cells[i].replace("Proposed", "Accepted", 1)
                    lines[number - 1] = "|".join(cells)
            if git_evidence(root, "show", f"{head}:{register}").decode("utf-8") != "".join(lines):
                raise ReadError(f"{register}: only candidate register status cells may change")
        print(
            f"Ratification of {len(candidates)} ADR(s) at {head} against {base}: eligible; pending human decision review"
        )
        return 0
    except (ReadError, OSError, UnicodeError, ValueError) as exc:
        error(ADR_DIR, f"ratification refused: {exc}")
        return 1


PIPED_FLAG = "--changed-on-stdin"


def main(argv, stdin):
    flags = [word for word in argv[1:] if word.startswith("-")]
    positional = [word for word in argv[1:] if not word.startswith("-")]

    # A mistyped flag must not read as "no list was piped", which would turn
    # rule 2 off silently.
    unknown = [flag for flag in flags if flag != PIPED_FLAG]
    if unknown or len(positional) > 1:
        print(f"::error::usage: {Path(argv[0]).name} [REPO_ROOT] [{PIPED_FLAG}]")
        return 1

    root = Path(positional[0] if positional else ".")
    on_trunk = os.environ.get("GITHUB_REF_NAME", "") == TRUNK
    piped = PIPED_FLAG in flags

    if not on_trunk and not piped:
        print(
            "::error::refusing to guess which ADRs this branch changed. Pipe "
            f"`git diff --name-only <trunk>...HEAD` and pass {PIPED_FLAG}, "
            "or run on the trunk"
        )
        return 1

    adrs, strays = adr_files(root)
    if not adrs:
        print(f"::error file={ADR_DIR}::no ADR files found")
        return 1

    changed = changed_adrs(adrs, stdin.read()) if piped else set()
    statuses, failures = check_statuses(adrs)
    failures += check_indexes(root, adrs, statuses)
    for path, why in strays:
        error(path, why)
        failures += 1

    if not failures and not on_trunk:
        failures += check_ratification(root, adrs, statuses, changed)
    if failures:
        return 1

    where = f"on '{TRUNK}'" if on_trunk else f"{len(changed)} changed by this branch"
    print(f"{len(adrs)} ADR statuses are valid and match every register ({where})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin))

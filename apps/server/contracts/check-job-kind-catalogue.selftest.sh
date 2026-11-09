#!/usr/bin/env bash
# Proves the job-kind check can fail, and that it fails for the right reason.
#
# Every assertion is on the MESSAGE the check prints, and on the exact exit
# status beside it. The check refuses in **nine** distinct ways at status 1 — a
# kind the catalogue lacks, a kind the enum lacks, the same kinds out of order, an
# undocumented kind, a row of the wrong width, and four per-step complaints — and
# in **fifteen** more at status 2, where it could not read an input at all. An
# exit status is one bit, so a run in which all but one of those branches works is
# indistinguishable from a run in which all of them work.
#
# Nine cases assert the opposite: that a CORRECT document is accepted. Over-strict
# is a defect too, and every one of those nine was a real refusal of a legitimate
# edit before it was a case.
#
# Status 2 is asserted separately from status 1 wherever an input is unreadable:
# "the two documents disagree" and "I could not read one of them" are different
# results, and a gate that conflates them cannot be trusted in either direction.
#
# Every case runs against COPIES in a scratch directory. Mutating the committed
# contract or catalogue in place would mean trusting a restore step to put a
# tracked file back.

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$here/.." && pwd)"
# The checker is overridable so the mutation run can point this file at a
# mutated COPY while the file itself stays here, next to the documents it reads.
# Relocating the self-test instead was tried: from a temp directory it cannot
# resolve the repository, so it aborted before a single case ran and every
# mutation read as "caught". A harness that produced no output is a failure to
# investigate, never a pass.
checker="${CHECKER:-$here/check_job_kind_catalogue.py}"
[ -f "$checker" ] || { echo "self-test FAILED: $checker is missing" >&2; exit 1; }

python_command="${PYTHON:-python3}"
work="$(mktemp -d "${TMPDIR:-/tmp}/job-kind-selftest.XXXXXX")"
trap 'rm -r -- "$work"' EXIT

contract="$work/core-api.openapi.yaml"
catalogue="$work/JOB_CATALOGUE.md"
cp "$root/contracts/core-api.openapi.yaml" "$contract"
cp "$root/docs/domain/JOB_CATALOGUE.md" "$catalogue"
cp "$contract" "$work/contract.pristine"
cp "$catalogue" "$work/catalogue.pristine"

fail() { echo "self-test FAILED: $1" >&2; exit 1; }

restore() { cp "$work/contract.pristine" "$contract"; cp "$work/catalogue.pristine" "$catalogue"; }

# Output first, status second. Read `$?` after a pipe and you get the pipe's.
_out=""
_status=0
run() {
  if _out="$("$python_command" "$checker" "$contract" "$catalogue" 2>&1)"; then
    _status=0
  else
    _status=$?
  fi
}

expect_status() {
  [ "$_status" -eq "$2" ] || fail "$1
  expected exit status: $2
  actual exit status:   $_status
  actual output: $_out"
}

# A substring: these messages carry document content, which is prose that will
# be reworded. The rule code and the reason are what distinguish the branches.
expect_refusal() {
  local label="$1" want="$2" status="${3:-1}"
  run
  printf '%s\n' "$_out" | grep -qF -- "$want" || fail "$label
  expected text: $want
  actual output: $_out"
  expect_status "$label: refused but exited wrong" "$status"
  printf '  ok  %s\n' "$label"
  restore
}

# Edits the scratch catalogue or contract in place with an exact, asserted
# replacement, so a fixture that silently stopped applying cannot read as a pass.
edit() {
  TARGET="$1" OLD="$2" NEW="$3" "$python_command" - <<'PY'
import os, pathlib
p = pathlib.Path(os.environ["TARGET"])
s = p.read_text(encoding="utf-8")
old, new = os.environ["OLD"], os.environ["NEW"]
assert old in s, f"fixture target absent in {p.name}: {old!r}"
p.write_text(s.replace(old, new, 1), encoding="utf-8")
PY
}

echo "job-kind-catalogue self-test"

# ── the committed pair agrees, and the summary says what was checked ────────
run
printf '%s\n' "$_out" | grep -qE '^16 job kinds agree in both directions and in order; 16 documented, 96 steps' \
  || fail "the committed contract and catalogue should agree
  actual output: $_out"
printf '%s\n' "$_out" | grep -qF 'step semantics and runtime behaviour unchecked' \
  || fail "the summary should say what it did NOT check
  actual output: $_out"
expect_status "the committed pair agrees but exited wrong" 0
printf '  ok  %s\n' "the committed pair agrees, and the summary names its own limits"

# The step count is what a reader takes as evidence of how much was examined, and
# asserting one number cannot tell a counted 96 from a literal 96 -- a mutation
# that hard-coded it passed the case above. So the count is asserted a second
# time against a document one step shorter.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |
" ""
run
printf '%s\n' "$_out" | grep -qF '95 steps name a proof' || fail \
  "the step count should follow the document, not be a constant
  actual output: $_out"
expect_status "the shorter catalogue agrees but exited wrong" 0
printf '  ok  %s\n' "the step count it reports is the number of steps there are"
restore

# ── the three ways the two lists can disagree, reported apart ───────────────
# By exit status these are one result. The rule code and the direction are the
# only things that tell a reader which of three repairs to make.
edit "$contract" "        - drift_check" "        - drift_check
        - teleport"
expect_refusal "a kind only the enum has is reported in that direction" \
  "JOB-LIST: JobKind has 'teleport'; §2 of docs/domain/JOB_CATALOGUE.md has no such kind"

edit "$catalogue" "| \`drift_check\` | yes | shared |" "| \`teleport\` | yes | shared |"
expect_refusal "a kind only the catalogue has is reported in the other direction" \
  "JOB-LIST: §2 of docs/domain/JOB_CATALOGUE.md has 'teleport'; JobKind's enum has not"

# Swapping two adjacent enum entries keeps both SETS identical, so only an
# order-aware comparison can see it. "In both directions" is satisfied by a set
# comparison; "in order" is not, and the contract claims both.
edit "$contract" "        - suspend
        - resume" "        - resume
        - suspend"
expect_refusal "the same kinds in a different order are caught" \
  "JOB-LIST: the same kinds in a different order"

# ── a kind in the table with nothing documenting it ─────────────────────────
# The row is valid and the enum agrees; only the heading is gone. Reported as
# JOB-DOC, not JOB-LIST, because the repair is to write the section.
edit "$catalogue" "### \`drift_check\`" "### \`drift_check_renamed_away\`"
expect_refusal "a kind no heading names is reported as undocumented" \
  "JOB-DOC: 'drift_check' is named by 0 '###' headings under §2"

# ...and the converse: two headings naming one kind is also not 1. A kind
# documented twice has two sets of steps and no answer to which is authoritative.
edit "$catalogue" "### \`export\`" "### \`export\`

### \`export\`"
expect_refusal "a kind named by two headings is reported too" \
  "is named by 2 '###' headings under §2"

# ── the per-step claims ────────────────────────────────────────────────────
# A proof name §1 does not define. The cell still LOOKS like a proof, which is
# the point: a typo reads as a proof and is not one.
edit "$catalogue" "| 1 | \`record_reason\` — reason and the notice that preceded it | \`commit-marker\`" \
  "| 1 | \`record_reason\` — reason and the notice that preceded it | \`commit-markre\`"
expect_refusal "a proof name §1 does not define is caught" \
  "JOB-STEP: step 1 claims the proof \`commit-markre\`, which §1 does not define"

# The SECOND name of a combination. Reading only the first name of the cell
# would let this through, and no other case would notice.
edit "$catalogue" "\`natural-key\` + \`command-id\`" "\`natural-key\` + \`command-di\`"
expect_refusal "a typo in the second name of a combined proof is caught" \
  "claims the proof \`command-di\`, which §1 does not define"

# A cell that names no proof at all, as opposed to naming a wrong one.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s" \
  "| 6 | \`apply_theme\` | to be decided | 60 s"
expect_refusal "a proof cell naming no proof at all is caught, and says so" \
  "which names no proof at all"

# An empty timeout. The rule is presence only -- one real row reads "remainder
# of the TTL", so a duration-shaped rule would refuse a correct document.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` |  |"
expect_refusal "a step with no timeout is caught" \
  "names no a timeout"

edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | Z |"
expect_refusal "a retry class §1 does not define is caught" \
  "claims the retry class Z, which §1 does not define"

edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A |  |"
expect_refusal "a step with no compensation is caught" \
  "names no a compensation"

# A row that lost a column entirely. Without this the unpacking below it would
# raise instead of reporting, which exits 1 for the wrong reason.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A |"
expect_refusal "a step row with the wrong number of columns is reported, not raised" \
  "cells, not 6"

# ── a correct document must not be refused ─────────────────────────────────
# Over-strict is a defect too: a gate that blocks a legitimate edit gets switched
# off. Each of these broke the first version of the parser and is now accepted.
# A guard that suppresses a duplicate or contradictory message can only be proven
# by asserting the message is ABSENT. Without this, every such guard survives
# mutation: removing it adds noise, and no case that greps for a wanted line
# notices a second unwanted one beside it.
expect_absent() {
  local label="$1" unwanted="$2"
  run
  if printf '%s\n' "$_out" | grep -qF -- "$unwanted"; then
    fail "$label
  this message should not have appeared: $unwanted
  actual output: $_out"
  fi
  printf '  ok  %s\n' "$label"
  restore
}

expect_accepted() {
  local label="$1"
  run
  [ "$_status" -eq 0 ] || fail "$label
  a legitimate edit was refused
  actual output: $_out"
  printf '  ok  %s\n' "$label"
  restore
}

# Markdown escapes a literal pipe in a cell as `\|`. Split on every pipe, this
# row counted seven cells and was refused.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` — light \\| dark | \`read-then-write\` | 60 s | A | reset to default |"
expect_accepted "an escaped pipe inside a cell is one cell, not two"

# A table that is not about steps. Any row whose first cell was a number used to
# be read as a step, so this was refused for having two cells instead of six.
edit "$catalogue" "### \`export\`" "### \`export\`

| Quota | Value |
|---|---|
| 1 | 5 GB |
"
expect_accepted "a non-step table under a kind is passed over, not read as steps"

# Alignment colons are ordinary Markdown and say nothing about content.
edit "$catalogue" "|---|---|---|---|---|---|" "|:--|:--|:--|--:|:-:|:--|"
expect_accepted "alignment colons in a separator row change nothing"

# The kind list comes from the table headed `Kind` and from nowhere else. A
# glossary table with a back-ticked first column would otherwise inject a kind
# that the enum is then reported as missing.
edit "$catalogue" "### \`export\`" "### \`export\`

| Term | Meaning |
|---|---|
| \`teleport\` | a word, not a job kind |
"
expect_accepted "a back-ticked first column elsewhere does not become a kind"

# A delimiter row with nothing above it is not a table either, and reaching the
# header read would index line -1.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text("|---|---|\n" + p.read_text(encoding="utf-8"), encoding="utf-8")
FIXTURE
expect_refusal "a delimiter row on the first line is refused" \
  "delimiter row with no header above it" 2

# ── examples are not data, and prose is not a table ────────────────────────
# A fenced block is how a documentation author SHOWS a row. So is a four-space
# indented block, which is ordinary Markdown and which the conservation rule below
# would otherwise refuse.
edit "$catalogue" "### \`export\`" "### \`export\`

A row, shown rather than used:

\`\`\`
| # | Step | Proof | Timeout | Retry | Compensation |
|---|---|---|---|---|---|
| 1 | \`example\` | \`no-such-proof\` | | Z | |
\`\`\`
"
expect_accepted "a table inside a code fence is an example, not data"

edit "$catalogue" "### \`export\`" "### \`export\`

For example:

    | # | Step | Proof | Timeout | Retry | Compensation |
    |---|---|---|---|---|---|
    | 1 | \`example\` | \`no-such-proof\` | | Z | |
"
expect_accepted "a table in a four-space indented block is an example too"

# ...and a table indented two or three spaces is a table in a LIST, not an
# example. An indented block cannot interrupt a paragraph, which is what separates
# the two without either rule naming the other.
edit "$catalogue" "### \`export\`" "### \`export\`

- a list item, with a table under it:

  | Quota | Value |
  |---|---|
  | 1 | 5 GB |
"
expect_accepted "a table nested in a list item is still a table"

# A fence closes only on its OWN marker. One flag toggled by either meant a \`\`\`
# line inside a ~~~ block closed it, and the document read as unclosed.
edit "$catalogue" "### \`export\`" "### \`export\`

~~~
\`\`\`
not a fence here
~~~
"
expect_accepted "a backtick line inside a tilde block does not close it"

# An unclosed fence blanks everything after it: one stray \`\`\` under §2 took the
# scan from 96 steps to 0, exit 0, with nothing able to notice.
edit "$catalogue" "### \`export\`" "### \`export\`

\`\`\`
"
expect_refusal "an unclosed code fence is refused, not left to blank the rest" \
  "opened and never closed" 2

# A lone row-shaped line is not a table in Markdown either -- without a delimiter
# row beneath it, it renders as the literal text it is.
edit "$catalogue" "### \`export\`" "### \`export\`

| # | Step | Proof |
"
expect_accepted "a row-shaped line with no delimiter row is prose, not a table"

# ── a table the parser did not read is the worst outcome there is ──────────
# Every one of these exited 0 with rows missing from the scan and an undefined
# proof among them. The only trace was the summary's number, and nothing asserts a
# number. A table is now anchored by its DELIMITER row, which GFM requires and
# which cannot be mistaken for prose -- so these are read rather than refused, and
# being read means being checked.
reshape_table() {  # $1 applied to each row line of one kind's table
  TARGET="$catalogue" MODE="$1" "$python_command" - <<'FIXTURE'
import os, pathlib
p = pathlib.Path(os.environ["TARGET"]); s = p.read_text(encoding="utf-8")
a = s.index("### `backup`"); b = s.index("### `restore`")
block = s[a:b].replace("`natural-key`", "`no-such-proof`")
mode = os.environ["MODE"]
def shape(line):
    if not line.startswith("|"):
        return line
    if mode == "indent":
        return "  " + line
    if mode == "quote":
        return "> " + line
    return line.strip("|")          # GFM makes the outer pipes optional
block = "\n".join(shape(l) for l in block.splitlines())
p.write_text(s[:a] + block + s[b:], encoding="utf-8")
FIXTURE
}

reshape_table indent
expect_refusal "an indented step table is read, so its bad proof is caught" \
  "claims the proof \`no-such-proof\`, which §1 does not define"

reshape_table quote
expect_refusal "a quoted step table is read too" \
  "claims the proof \`no-such-proof\`, which §1 does not define"

# The one that mattered most: GFM makes the outer pipes optional on EVERY row, and
# keying on a leading pipe read 15 kinds out of 16 and called it agreement in both
# directions.
reshape_table strip
expect_refusal "a step table with no outer pipes is read, not skipped" \
  "claims the proof \`no-such-proof\`, which §1 does not define"

edit "$catalogue" "| \`realm_update\` | no (organisation) | none | none | staff only | 1–5 min |" \
  " \`realm_update\` | no (organisation) | none | none | staff only | 1–5 min "
edit "$contract" "        - realm_update
" ""
expect_refusal "a pipe-less kind row is read, so dropping it from the enum is caught" \
  "JOB-LIST: §2 of docs/domain/JOB_CATALOGUE.md has 'realm_update'; JobKind's enum has not"

# A delimiter row whose header disagrees with it is not a table, and the rows under
# it belong to nothing. Refusing beats guessing which of the two is wrong.
edit "$catalogue" "| Kind | Tenant-scoped | Lock | Drives status to | Self-service at launch | Typical duration |" \
  "| Kind | Tenant-scoped | Lock |"
expect_refusal "a delimiter row that anchors no table is refused" \
  "so it is not a table" 2

# A steps table outside §2 is a steps table nobody reads. A sibling `## 2.1` is the
# plausible way it gets there, and §2's slice ends at any sibling `##`.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
a = s.index("### `backup`"); b = s.index("### `restore`")
block = s[a:b]
p.write_text(s[:a] + s[b:].replace("## 3.", "## 2.1 Step tables\n\n" + block + "\n## 3.", 1),
             encoding="utf-8")
FIXTURE
expect_refusal "a steps table outside §2 is refused, not quietly unread" \
  "is a steps table outside §2" 2

# JOB-DOC reads its headings from the same blanked lines the tables come from. Read
# from the raw text, a `###` line inside a fence "documented" a kind.
"$python_command" - "$catalogue" "$contract" <<'FIXTURE'
import pathlib, sys
cat, con = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = cat.read_text(encoding="utf-8")
row = "| `realm_update` | no (organisation) | none | none | staff only | 1–5 min |"
s = s.replace(row, row + "\n| `realm_delete` | no (organisation) | none | none | staff only | 1–5 min |", 1)
cat.write_text(s.replace("## 3.", "```\n### `realm_delete`\n```\n\n## 3.", 1), encoding="utf-8")
t = con.read_text(encoding="utf-8")
con.write_text(t.replace("        - realm_update\n",
                         "        - realm_update\n        - realm_delete\n", 1), encoding="utf-8")
FIXTURE
expect_refusal "a heading inside a fence does not document a kind" \
  "JOB-DOC: 'realm_delete' is named by 0 '###' headings under §2"

# A steps table is MARKED by its ordinal column and its header is then asserted.
# Recognising it by the whole header instead meant renaming one column silently
# dropped five rows from the scan — 96 steps became 91 — and exited 0.
edit "$catalogue" "| # | Step | Idempotency proof | Timeout | Retry | Compensation |" \
  "| # | Step | Idempotency proof | Timeout | Retry | Undo |"
expect_refusal "a renamed steps-table header is refused, not silently skipped" \
  "a steps table header does not end in 'Compensation'" 2

# ── what a third review found, hunting only for "can it pass while they disagree" ──
# The widest hole in the check. An HTML comment flush against a table's last row ends
# the table in GFM -- the renderer agrees -- while a line-based reader walks straight
# on, so a commented-out row was harvested as a DEFINITION. A retry class defined
# nowhere a reader can see became legal, and the summary still said 96 steps name a
# class §1 defines.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
d = "| `D` | 10 | fixed 60 s |"
i = s.index(d); j = s.index("\n", i)
s = s[: j + 1] + "<!--\n| `E` | 20 | fixed 5 min | Draft: not in use yet |\n-->\n" + s[j + 1 :]
m = re.search(r"^\| 1 \|.*\| A \| .*\|$", s, re.M)
assert m, "fixture: no step row to poison"
p.write_text(s[: m.start()] + m.group(0).replace("| A |", "| E |", 1) + s[m.end() :],
             encoding="utf-8")
FIXTURE
expect_refusal "a commented-out §1 row does not define anything" \
  "does not open with a back-ticked name" 2

# A §1 table with a header and no rows at all still names nothing, and that branch is
# reachable only this way now that a non-name row is refused outright.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
start = s.index("**Retry policy classes.**")
head = s.index("| Class | Attempts | Backoff | Applies to |", start)
end = s.index("\n\nA job's `max_attempts`", head)
p.write_text(s[:head] + "| Class | Attempts |\n|---|---|" + s[end:], encoding="utf-8")
FIXTURE
expect_refusal "a §1 table with no rows at all names nothing" \
  "names nothing" 2

# `or` joins two proof names as readily as `+` does, and §1's own wording is "is one
# of". Reading a leading run joined by `+` or `and` missed `or`, `/`, `,` and `<br>`.
# Every code span OUTSIDE a parenthetical is a name now.
edit "$catalogue" "\`natural-key\` + \`command-id\`" "\`command-id\` or \`content-hash\`"
expect_refusal "a proof name joined by 'or' is validated too" \
  "claims the proof \`content-hash\`, which §1 does not define"

edit "$catalogue" "\`natural-key\` + \`command-id\`" "\`command-id\` / \`content-hash\`"
expect_refusal "...and one joined by a slash" \
  "claims the proof \`content-hash\`, which §1 does not define"

# ...while the identifiers inside a parenthetical are still explanation, not names.
# Three real rows read `` \`natural-key\` (\`tenant\`, \`name\`, \`version\`) ``.
expect_accepted "identifiers inside a parenthetical are not proof names"

# A cell can be non-empty and render to nothing. Both of these counted as a filled-in
# timeout and a filled-in compensation.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | <!-- TODO decide --> | A | reset to default |"
expect_refusal "a timeout that is only an HTML comment is no timeout" \
  "names no a timeout"

edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | &nbsp; |"
expect_refusal "a compensation that is only an entity is no compensation" \
  "names no a compensation"

# A tab is legal in a delimiter row, and GFM reads the table. One tab made the whole
# table stop being a table here, and the rows it took with it carried an undefined
# proof — so this asserts the table is still READ, by poisoning a row of it.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
i = s.index("### `backup`")
bar = "|---|---|---|---|---|---|"
j = s.index(bar, i)
s = s[:j] + "|---|---|---\t|---|---|---|" + s[j + len(bar):]
k = s.index("`natural-key`", j)
p.write_text(s[:k] + "`bogus-proof`" + s[k + len("`natural-key`"):], encoding="utf-8")
FIXTURE
expect_refusal "a tab in a delimiter row still leaves the table read" \
  "claims the proof \`bogus-proof\`, which §1 does not define"

# An HTML block is not Markdown. A `###` line inside `<pre>` counted as a kind's
# section while the renderer showed no heading at all, so a kind could be
# "documented" by an example.
edit "$catalogue" "### \`drift_check\`" "<pre>
### \`drift_check\`
</pre>"
expect_refusal "a heading inside an HTML block does not document a kind" \
  "JOB-DOC: 'drift_check' is named by 0 '###' headings under §2"

# ...and an HTML block left open would blank the rest of the document, the same way
# an unclosed fence did.
edit "$catalogue" "### \`export\`" "### \`export\`

<pre>
"
expect_refusal "an unclosed HTML block is refused, not left to blank the rest" \
  "opened and never closed" 2

# ── the refusals and guards a mutation found owned by nothing ───────────────
# Renaming §2's kind-table header leaves sixteen kinds unreadable. That is "I could
# not find the table", not "the documents disagree", and the difference is sixteen
# status-1 findings versus one status-2 refusal.
edit "$catalogue" "| Kind | Tenant-scoped |" "| Job kind | Tenant-scoped |"
expect_refusal "a renamed kind-table header is an input refusal, not sixteen findings" \
  "§2 has no table headed 'Kind'" 2

# A kind name is read from the START of its cell. Unanchored, a cell whose prose
# merely contains a code span would name a kind.
edit "$catalogue" "| \`drift_check\` | yes | shared |" "| see \`drift_check\` | yes | shared |"
expect_refusal "a code span later in a kind cell does not name the kind" \
  "does not open with a back-ticked kind" 2

# A delimiter row must contain a dash. Without that, a row of empty cells is a
# delimiter, and the real row above it becomes a header.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |
|  |  |  |  |  |  |"
expect_refusal "a row of empty cells is not a delimiter row" \
  "names no a proof"

# Three guards that suppress a second, contradictory message about the same cell.
edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s |  | reset to default |"
expect_absent "an empty retry cell is reported once, not also as an undefined class" \
  "claims the retry class , which"

edit "$catalogue" "| 6 | \`apply_theme\` | \`read-then-write\` | 60 s | A | reset to default |" \
  "| 6 | \`apply_theme\` |  | 60 s | A | reset to default |"
expect_absent "an empty proof cell is reported once, not also as naming no proof" \
  "which names no proof at all"

# And the order report is suppressed while the two lists differ in MEMBERSHIP:
# lists of different length are trivially in a different order, and saying so sends
# the reader to the wrong repair.
edit "$contract" "        - drift_check" "        - drift_check
        - teleport"
expect_absent "the order report is silent while the lists differ in membership" \
  "the same kinds in a different order"

# A heading ends a table, blank line or not. Without that rule the heading line is
# absorbed as a one-cell row -- and the kind it names loses its section with it.
# (A paragraph IS absorbed, which is what GFM does, so the fixture has to abut a
# heading rather than prose.)
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
assert "\n\n### `export`" in s, "fixture"
table = (
    "\n\n| # | Step | Proof | Timeout | Retry | Compensation |\n"
    "|---|---|---|---|---|---|\n"
    "| 1 | `extra` | `guarded` | 1 s | A | none |\n"
    "### `export`"
)
p.write_text(s.replace("\n\n### `export`", table, 1), encoding="utf-8")
FIXTURE
expect_accepted "a heading ends a table even with no blank line before it"

# An indented block cannot interrupt a paragraph, so four-space indentation right
# after a sentence is a continuation and still data -- which is what keeps the
# example rule from swallowing a real table that happens to be indented.
edit "$catalogue" "### \`export\`" "### \`export\`

A sentence, and then an indented table that is NOT an example:
    | # | Step | Proof | Timeout | Retry | Compensation |
    |---|---|---|---|---|---|
    | 1 | \`x\` | \`no-such-proof\` | 1 s | A | none |
"
expect_refusal "four-space indentation after a sentence is data, not an example" \
  "claims the proof \`no-such-proof\`, which §1 does not define"

# ── the catalogue→enum direction, which is half the claim ──────────────────
# A kind cell names its kind first and may annotate it. Requiring the WHOLE cell
# to be one code span meant the catalogue could document a kind, with its own
# section and its own steps, while the check reported both directions agreeing.
edit "$catalogue" "| \`realm_update\` | no (organisation) | none | none | staff only | 1–5 min |" \
  "| \`realm_update\` | no (organisation) | none | none | staff only | 1–5 min |
| \`realm_delete\` (new in 0.9) | no (organisation) | none | none | staff only | 1–5 min |"
expect_refusal "an annotated kind cell is still read, so the enum gap is caught" \
  "JOB-LIST: §2 of docs/domain/JOB_CATALOGUE.md has 'realm_delete'; JobKind's enum has not"

# ...and a kind row that names no kind at all is refused rather than skipped.
edit "$catalogue" "| \`drift_check\` | yes | shared |" "| drift_check | yes | shared |"
expect_refusal "a kind row with no back-ticked kind is refused, not skipped" \
  "does not open with a back-ticked kind" 2

# A footnote on an existing kind is a legitimate edit and must still read.
edit "$catalogue" "| \`drift_check\` | yes | shared |" "| \`drift_check\`[^1] | yes | shared |"
expect_accepted "a footnote marker on a kind leaves the kind readable"

# ── "and" joins two proof names in this document's own idiom ───────────────
# Its own headings read "### \`add_domain\` and \`remove_domain\`", so reading only
# the "+" form left a second name after "and" unvalidated.
edit "$catalogue" "\`natural-key\` + \`command-id\`" "\`natural-key\` and \`nonsense-proof\`"
expect_refusal "a second proof name joined by 'and' is validated too" \
  "claims the proof \`nonsense-proof\`, which §1 does not define"

edit "$catalogue" "\`natural-key\` + \`command-id\`" "\`natural-key\` and \`command-id\`"
expect_accepted "...and 'and' between two defined names is accepted"

# Emphasis around a proof name still names a proof. Refusing it refused a correct cell.
edit "$catalogue" "| 7 | \`verify\` — discovery document reachable, a scripted authentication round-trip succeeds | \`guarded\`" \
  "| 7 | \`verify\` — discovery document reachable, a scripted authentication round-trip succeeds | **\`guarded\`**"
expect_accepted "a proof name wrapped in emphasis still names a proof"

# ── "could not look" exits 2, never 1 ──────────────────────────────────────
# Each of these reads as a clean pass to a gate that only reads exit 0.
edit "$contract" "    JobKind:
      type: string" "    JobKindRenamed:
      type: string"
expect_refusal "a contract with no JobKind enum is an input refusal, not a finding" \
  "JOB-INPUT:" 2

edit "$catalogue" "## 2. The kinds" "## 2bis. The kinds"
expect_refusal "a catalogue with no '## 2.' section is an input refusal" \
  "JOB-INPUT:" 2

# A contract that is not valid YAML. Uncaught, this escaped as a traceback at
# status 1 -- indistinguishable, to anything reading the status, from the two
# documents genuinely disagreeing. A conflict marker or one slipped indent lands
# here, and both this file and the spec promised status 2.
edit "$contract" "    JobKind:" "    JobKind:
  \tbad indent: ["
expect_refusal "a contract that is not valid YAML is an input refusal, not a finding" \
  "is not valid YAML" 2

edit "$catalogue" "A step's idempotency proof is one of:" \
  "A step's idempotency proof is drawn from:"
expect_refusal "a §1 that no longer defines the proofs is an input refusal" \
  "JOB-INPUT:" 2

edit "$catalogue" "**Retry policy classes.**" "**Retry policy classes, revised.**"
expect_refusal "a §1 that no longer defines the retry classes is an input refusal" \
  "JOB-INPUT:" 2

# ── the input refusals that were implemented and unproven ──────────────────
# Each of these was in the checker and owned by no case, so mutating it away left
# every case above still passing. The spec advertises the first of them by name.
"$python_command" - "$contract" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
# Padded past the 2 MiB bound with a YAML comment, so the file stays valid and the
# refusal can only come from the bound itself.
p.write_text(p.read_text(encoding="utf-8") + "\n" + "# pad\n" * 400000, encoding="utf-8")
FIXTURE
expect_refusal "a contract over the declared size bound is refused" \
  "is larger than" 2

printf 'policy \351 not utf-8\n' > "$catalogue"
expect_refusal "a catalogue that is not UTF-8 is refused, not decoded lossily" \
  "is not UTF-8" 2
restore

edit "$contract" "        - bootstrap_verify" "        - 7"
expect_refusal "an enum entry that is not a string is refused" \
  "is not a list of strings" 2

# An empty enum is the vacuous case: nothing to compare, so nothing disagrees.
"$python_command" - "$contract" <<'FIXTURE'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
start = s.index("    JobKind:")
head = s.index("      enum:", start)
tail = s.index("\n    ", s.index("        - realm_update", head))
p.write_text(s[:head] + "      enum: []" + s[tail:], encoding="utf-8")
FIXTURE
expect_refusal "an empty enum is refused rather than agreeing with nothing" \
  "enum is empty" 2

if _out="$("$python_command" "$checker" "$contract" "$catalogue" extra 2>&1)"; then _status=0; else _status=$?; fi
printf '%s\n' "$_out" | grep -qF -- "usage:" || fail "a third argument should print usage
  actual output: $_out"
expect_status "a third argument printed usage but exited wrong" 2
printf '  ok  %s\n' "a third argument is refused with usage, not ignored"

# §1's two tables are READ, so a §1 that names nothing is a refusal rather than a
# permitted set that is silently empty -- which would refuse every step.
"$python_command" - "$catalogue" <<'FIXTURE'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
old = "| `declarative` | The tool converges"
assert old in s
start = s.index("A step's idempotency proof is one of:")
head = s.index("| Proof | Meaning | Typical step |", start)
end = s.index("\n\nA step with none of these", head)
p.write_text(s[:head] + "| Proof | Meaning |\n|---|---|\n| none named | nothing |" + s[end:],
             encoding="utf-8")
FIXTURE
expect_refusal "a §1 row that names nothing is refused, not skipped" \
  "does not open with a back-ticked name" 2

# An annotated first cell in §1 is a legitimate edit and must still name the proof.
edit "$catalogue" "| \`declarative\` | The tool converges" \
  "| \`declarative\` (the default) | The tool converges"
expect_accepted "an annotated name in §1 still defines that proof"

# JOB-DOC counts headings under §2 only. Counting them document-wide would let a
# heading in §3 or §5 stand in for the section a kind is missing.
edit "$catalogue" "### \`drift_check\`" "### drift_check_renamed_away"
edit "$catalogue" "## 5. What a reviewer checks" "## 5. What a reviewer checks

### \`drift_check\`
"
expect_refusal "a heading outside §2 does not document a kind" \
  "JOB-DOC: 'drift_check' is named by 0 '###' headings under §2"

rm "$catalogue"
expect_refusal "a missing catalogue is an input refusal, not a clean pass" \
  "is not a file" 2
cp "$work/catalogue.pristine" "$catalogue"

run
expect_status "the pair agrees again once every fixture is restored" 0
printf '  ok  %s\n' "the pair agrees again once every fixture is restored"

echo "self-test passed: agreement and its summary, a kind in each list alone,"
echo "the same kinds out of order, an undocumented kind, a kind documented"
echo "twice, an undefined proof in first and second position, a cell naming no"
echo "proof, a missing timeout, an undefined retry class, a missing"
echo "compensation, a short row, four tables the parser could have failed to read,"
echo "an annotated and a footnoted kind cell, a kind row naming no kind, 'and' as a"
echo "proof joiner, emphasis, an escaped pipe, a non-step table, alignment colons,"
echo "a back-ticked column that is not a kind, a fenced example, a renamed steps"
echo "header and an unparseable contract — each proved by its own message AND its"
echo "own exit status"

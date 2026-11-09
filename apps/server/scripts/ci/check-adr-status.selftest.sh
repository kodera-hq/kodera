#!/usr/bin/env bash
# Proves the ADR status check can fail, and fails for the reason it names.
#
# `premature` refuses acceptance without merged-proposal evidence. The separate
# Git-backed suite proves a later status-only ratification can be eligible,
# without asserting human approval. `no-list` refuses an omitted changed-file
# input; `untouched` keeps already accepted, unmodified decisions valid.
#
# ## What this file got wrong, so that the next version does not
#
# **Every register needs a fixture of its own.** The check polices two, and for
# a while every fixture here mutated only `docs/adr/README.md` — so dropping
# `docs/INDEX.md` from `INDEXES` left the suite twelve for twelve green. Half
# the rule had no test at all. The `index2-` cases exist for that half.
#
# **A case has to assert what was said, not only the exit code.** Loosening
# `SUPERSEDED` to `^Superseded` also left the suite green, because nothing
# distinguished a refusal from a pass that happened to fail elsewhere. Each
# case below therefore names the sentence the check has to print, and a case
# that exits correctly for a different reason is a failure.
#
# **A scan that skips what it cannot classify publishes a count it has not
# earned.** The `stray-` cases cover the file-name shapes that used to turn the
# check off for one decision without a word, while the run still printed
# "8 ADR statuses are valid and match every register".
#
# **A pattern decides what counts as an entry before anything classifies it.**
# `glob("*.md")` was replaced by `rglob("*.md")` to catch a subdirectory, and
# four shapes still walked through the pattern rather than through the rules:
# `0009-ninth-decision` with no extension, `.markdown`, `.txt`, and a
# *symlinked* subdirectory, which `rglob` does not walk into. Each exited 0 on
# the previous version of the check, printing the sentence above. They are
# `stray-no-extension`, `stray-markdown`, `stray-txt` and `stray-symlinked-dir`
# below. `stray-symlinked-adr` is the fifth: a link named `0009-…` pointing at
# `0001-…`, listed in both registers, which the previous version counted as a
# second decision and reported "2 ADR statuses are valid".
#
# **A row was bound to an ADR by the file name at the end of its link.** The
# directory half was resolved by nothing and thrown away by `os.path.basename`,
# so a row never had to point at the decision it reported on. A
# `docs/adr/README.md` row whose link left the directory for a different real
# file — one saying `Accepted` beside a decision saying `Proposed` — exited 0
# with "1 ADR statuses are valid and match every register", and so did
# `docs/INDEX.md` writing its `adr/0001-…` link as `docs/adr/0001-…`, which
# from inside `docs/` resolves to `docs/docs/adr/…` and lands nowhere.
# `index-row-redirected` and `index2-row-wrong-depth` are those two. The
# registers sit at different depths and write one ADR two ways, so
# `index-row-equivalent-path` holds the rule to resolving a path rather than to
# matching a string, `index-row-off-register` holds the register inside
# `docs/adr` to indexing `docs/adr`, and `index2-row-not-an-adr` holds the
# other side: the repo-wide index lists documents that are not decisions, and
# one of them numbered `0001-` must not redden an ADR gate.
#
# **A row was dropped before anything classified it, by the pattern that
# finds one.** Everything above this line is about what happens to a row once
# `ROW_LINK` has read it, and `ROW_LINK` ended in `\.md\)`. Four link spellings
# a Markdown renderer follows straight to the ADR missed it — `…md#status`,
# `…md?plain=1`, `<…md>`, `<…md#status>` — so the row never reached any of it.
# One such row appended to either register, saying `Accepted` beside a row
# saying `Proposed` for the same decision, exited 0 on all eight combinations
# printing "1 ADR statuses are valid and match every register", while the plain
# spelling of the same row was caught. `index-row-fragment` through
# `index2-row-angle-fragment` are those eight.
#
# The comment above that pattern made it worse than the pattern alone: it said
# `[^)]+` was "deliberately wide" so that the pattern "has to see every row",
# with the narrowing it denied sitting on the next line. So the narrowing is
# now stated, and `index-row-decorated-agrees` holds it to *reading* a
# decorated link rather than refusing one — a fix that reddened every `#`, `?`
# or `<` would leave the eight green while breaking a register that is correct.
#
# **And a narrowing has to answer for what it excludes.** A row link outside
# the shapes read is classified like any other, and one naming `docs/adr` fails
# instead of vanishing: `index-row-unread-shape` and `index2-row-unread-shape`.
# Both used to surface, at best, as "no row in <register>, so its status is
# unpoliced there" — a sentence sending a reader to add a row already in front
# of them — so both assert the sentence and not the exit.
# `index2-row-unread-elsewhere` is the limit: `docs/INDEX.md` indexes documents
# that are not Markdown, and failing on those is how a gate gets switched off.
#
# **And a row can hold no punctuation either pattern looks for.** The paragraph
# above says a narrowing has to answer for what it excludes, and named
# `UNREAD_LINK` as the answer — a pattern anchored on `](`. CommonMark's other
# link syntax carries none: a reference link names a label and keeps the
# destination in a definition elsewhere in the file, so `ROW_LINK` found nothing,
# `UNREAD_LINK.findall` returned an empty list, and the row left through a bare
# `continue`. On this repository's own registers, unmodified check, on the trunk:
#
#     [adr1]: 0001-profile-and-agent-contracts.md
#     | [0001][adr1] | Profile and agent contracts | Accepted |
#     -> 4 ADR statuses are valid and match every register (on 'main')   exit 0
#
# Three shapes escape per register, because a renderer resolves three —
# `[text][label]`, `[label][]`, `[label]` — and where such a row was the
# decision's only one, the run printed "no row in docs/adr/README.md, so its
# status is unpoliced there": the sentence two paragraphs up was added to stop
# saying, said again through a syntax that paragraph did not cover. The
# `index-row-reference-` and `index2-row-reference-` cases are those six plus the
# definition forms a reader written for one line would miss — a title, a
# destination on the next line, a destination in angle brackets, a label under
# another case and spacing. `index-row-reference-agrees` is their green, and
# `index2-row-bracketed-text`, `index2-row-reference-elsewhere` and
# `index2-row-inline-not-shortcut` are the three limits: a bracketed word is not
# a link, a resolved reference row about some other document is passed over like
# an inline one, and `[text](destination)` stays the inline shape even when its
# text spells a defined label. `index-row-html-anchor` and
# `index2-row-html-anchor` hold the one shape refused rather than read.
#
# **A pattern is only as narrow as its narrowest half.** `ADR_NAME` read
# `^(\d{4})-[a-z0-9-]+\.md$`. `\d` is Unicode-aware and the slug beside it is
# ASCII, so four digits from any script bought a second name for one decision
# number: `٠٠٠٩-ninth-decision.md` beside `0009-ninth-decision.md`, both listed
# in both registers, both reading `| [0009](…) |` to a human — "3 ADR statuses
# are valid and match every register", exit 0, and the same for N'Ko and
# fullwidth. `stray-unicode-digits` is that shape in three scripts, because one
# spelling is a typo and three are a class. `SUPERSEDED` carried the same
# `\d{4}` beside an ASCII literal and is `superseded-unicode-digits`.
# `index-row-unicode-digits` is the register half, and it is also what keeps
# `ADR_SHAPED` deliberately wide: that pattern has to stay wider than `ADR_NAME`
# so a name `ADR_NAME` refuses inside `docs/adr` is reported rather than passed
# over, and narrowing it for symmetry is caught by that case.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-adr-status.py"

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/adr-status-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# A valid register: one ADR, the template, and the two indexes that restate it.
fixture() {
  local dir="$work/$1"
  mkdir -p "$dir/docs/adr"

  cat > "$dir/docs/adr/0000-template.md" <<'MD'
# ADR-0000: Title

**Status:** Proposed | Accepted | Superseded by ADR-nnnn
**Deciders:** the crew
MD

  cat > "$dir/docs/adr/0001-first-decision.md" <<'MD'
# ADR-0001: First decision

**Status:** Proposed
**Deciders:** the crew

## Context
MD

  cat > "$dir/docs/adr/README.md" <<'MD'
# Architecture decision records

Template: [`0000-template.md`](0000-template.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-first-decision.md) | First decision | Proposed |
MD

  cat > "$dir/docs/INDEX.md" <<'MD'
# Documentation index

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`adr/README.md`](adr/README.md) | Proposed | API seat | ADR register |
| [`adr/0001-first-decision.md`](adr/0001-first-decision.md) | Proposed | API seat | First decision |
| [`api/AUTHZ.md`](api/AUTHZ.md) | Proposed | API seat | Not an ADR row, and must stay unread |
MD
}

# Restate one status in the ADR and in both registers at once, so a fixture
# fails for the reason it names rather than for a row left behind.
restate() {
  local dir="$work/$1" status="$2"
  local adr="$dir/docs/adr/0001-first-decision.md"
  python3 - "$adr" "$dir/docs/adr/README.md" "$dir/docs/INDEX.md" "$status" <<'PY'
import sys

adr, readme, index, status = sys.argv[1:5]

with open(adr, encoding="utf-8") as handle:
    body = handle.read().replace("**Status:** Proposed", f"**Status:** {status}", 1)
with open(adr, "w", encoding="utf-8") as handle:
    handle.write(body)

for path in (readme, index):
    lines = []
    for line in open(path, encoding="utf-8").read().splitlines(keepends=True):
        if "0001-first-decision.md)" in line:
            line = line.replace("| Proposed |", f"| {status} |", 1)
        lines.append(line)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("".join(lines))
PY
}

# Replace text in one file of a fixture, for the malformed cases below.
edit() {
  python3 - "$work/$1" "$2" "$3" <<'PY'
import sys

path, old, new = sys.argv[1:4]
with open(path, encoding="utf-8") as handle:
    body = handle.read()
if old not in body:
    sys.exit(f"self-test is broken: {old!r} not in {path}")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(body.replace(old, new, 1))
PY
}

# Drop a ninth decision into a fixture under a name of our choosing.
# stray <fixture> <path under docs/adr> <status line, or "" for none>
stray() {
  local target="$work/$1/docs/adr/$2" status="$3"
  mkdir -p "$(dirname "$target")"
  {
    printf '# ADR-0009: A new decision\n\n'
    [ -n "$status" ] && printf '**Status:** %s\n' "$status"
    printf '**Deciders:** the crew\n\n## Context\n'
  } > "$target"
}

# Add a row for a ninth decision to both registers, so a fixture that would
# otherwise fail on a missing row fails on the shape it is named after instead.
list_ninth() {
  local dir="$work/$1" name="$2"
  printf '| [0009](%s) | Ninth decision | Proposed |\n' "$name" \
    >> "$dir/docs/adr/README.md"
  # The backticks are how `docs/INDEX.md` writes a path; nothing here expands.
  # shellcheck disable=SC2016
  printf '| [`adr/%s`](adr/%s) | Proposed | API seat | Ninth decision |\n' \
    "$name" "$name" >> "$dir/docs/INDEX.md"
}

# A second row for the first decision, under a link spelling of our choosing,
# saying `Accepted` while the ADR and the row already there say `Proposed`.
#
# The disagreement is what makes each case readable: the run is green exactly
# when the row was dropped, and red exactly when it was read. Appending rather
# than rewriting is deliberate — it is the shape that exited 0 with nothing
# missing and nothing unpoliced, so no other rule can redden it by accident and
# take the credit.
#
# second_row <fixture> <readme|index> <link, written exactly as in the file>
second_row() {
  local dir="$work/$1" which="$2" link="$3"
  if [ "$which" = readme ]; then
    printf '| [0001](%s) | First decision | Accepted |\n' "$link" \
      >> "$dir/docs/adr/README.md"
  else
    # The backticks are how `docs/INDEX.md` writes a path; nothing here expands.
    # shellcheck disable=SC2016
    printf '| [`adr/0001-first-decision.md`](%s) | Accepted | API seat | First decision |\n' \
      "$link" >> "$dir/docs/INDEX.md"
  fi
}

# A second row for the first decision written in CommonMark's *other* link
# syntax, saying `Accepted` while the ADR and the row already there say
# `Proposed`. The definition goes after the table, which is where a register
# writing one would put it; an empty definition argument leaves the label
# undefined on purpose.
#
# reference_row <fixture> <readme|index> <bracket run> [definition]
reference_row() {
  local dir="$work/$1" which="$2" text="$3" definition="${4:-}" file
  if [ "$which" = readme ]; then
    file="$dir/docs/adr/README.md"
    printf '| %s | First decision | Accepted |\n' "$text" >> "$file"
  else
    file="$dir/docs/INDEX.md"
    printf '| %s | Accepted | API seat | First decision |\n' "$text" >> "$file"
  fi
  [ -n "$definition" ] && printf '\n%s\n' "$definition" >> "$file"
  return 0
}

# The characters of a number, from their code points. Built rather than pasted
# because a file about which code points count must not depend on its own bytes
# surviving an editor, a copy or a normalising tool, and because `٠٠٠٩` (Arabic-
# Indic) and `۰۰۰۹` (Extended Arabic-Indic) are different numbers that look
# alike — a reader of this file has to be able to tell which one is under test.
digits() {
  python3 -c 'import sys; print("".join(chr(int(a, 16)) for a in sys.argv[1:]), end="")' "$@"
}

# Seconds a single case may take. The check reads a handful of small files, so
# this is not a performance budget: it is the difference between "refused" and
# "never answered". One fixture holds a named pipe, and a version of the check
# that classified it as an ADR would block on the open forever — a case that
# hangs is a case that never says anything, and every reader waits for a verdict
# that is not coming. A limit turns that into a failure with the case's name on
# it, which is the only form a self-test result may take.
LIMIT=20

# expect <exit> <fixture> <ref> <changed paths piped in> <flag or -> <text...>
#
# The trailing strings are the case. Without them "exit 1" says only that
# something somewhere went wrong, which is how a case can pass while the rule
# it is named after has been deleted.
expect() {
  local want="$1" fixture="$2" ref="$3" changed="$4" flag="$5" got=0 out="" text
  shift 5
  local -a args=("$work/$fixture")
  [ "$flag" != "-" ] && args+=("$flag")

  local capture="$work/.expect-output" runner watchdog
  : > "$capture"
  printf '%s' "$changed" \
    | GITHUB_REF_NAME="$ref" python3 "$script" "${args[@]}" > "$capture" 2>&1 &
  runner=$!
  # Polls rather than sleeping the whole limit, so it is gone a second after the
  # case is, and its output goes nowhere: a watchdog holding the script's stdout
  # open makes every downstream reader wait out the limit on a passing run.
  {
    remaining="$LIMIT"
    while [ "$remaining" -gt 0 ]; do
      kill -0 "$runner" 2>/dev/null || exit 0
      sleep 1
      remaining=$((remaining - 1))
    done
    kill -9 "$runner"
  } > /dev/null 2>&1 &
  watchdog=$!
  wait "$runner" 2>/dev/null || got=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  out="$(cat "$capture")"

  # 137 is the watchdog's SIGKILL. Reported separately because "expected 1, got
  # 137" reads like a crash, and this is the opposite: no verdict at all.
  if [ "$got" -eq 137 ] && [ "$want" -ne 137 ]; then
    echo "self-test FAILED: '$fixture' gave no verdict within ${LIMIT}s" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$fixture' expected exit $want, got $got" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  [ "$#" -gt 0 ] || { echo "self-test FAILED: '$fixture' asserts nothing" >&2; exit 1; }
  for text in "$@"; do
    if ! printf '%s\n' "$out" | grep -qF -- "$text"; then
      echo "self-test FAILED: '$fixture' exited $want, but not for its own reason;" >&2
      echo "  the output had to contain: $text" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
  done
  printf '  ok  %-26s exit %s\n' "$fixture" "$got"
}

branch="fix/a-branch"
adr="docs/adr/0001-first-decision.md"
piped="--changed-on-stdin"

# Three unrelated Unicode blocks, each spelling 0009 in category-Nd characters
# that `\d` accepts and `[0-9]` does not.
arabic_indic="$(digits 0660 0660 0660 0669)"   # ARABIC-INDIC DIGIT ZERO / NINE
nko="$(digits 07C0 07C0 07C0 07C9)"            # NKO DIGIT ZERO / NINE
fullwidth="$(digits FF10 FF10 FF10 FF19)"      # FULLWIDTH DIGIT ZERO / NINE

echo "adr-status self-test"

fixture clean
expect 0 clean "$branch" "$adr" "$piped" \
  "1 ADR statuses are valid and match every register (1 changed by this branch)"

# Acceptance without readable merged-proposal evidence remains a refusal.
fixture premature
restate premature Accepted
#
# A bare acceptance without readable merged-proposal evidence remains refused.
expect 1 premature "$branch" "$adr" "$piped" \
  "ratification refused" "cannot read ratification Git evidence"

# The same tree on the trunk is the legitimate flip, not a defect.
fixture merged
restate merged Accepted
expect 0 merged main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register (on 'main')"

# An accepted ADR this branch did not touch is not this branch's doing.
fixture untouched
restate untouched Accepted
# Prove untouched status from actual synthetic history, not an empty caller list.
git -C "$work/untouched" init -qb fix/fixture
git -C "$work/untouched" add docs
git -C "$work/untouched" -c core.hooksPath=/dev/null -c user.name='Fixture Author' \
  -c user.email=author@example.test commit -qm 'Record accepted fixture'
git -C "$work/untouched" update-ref refs/remotes/origin/main HEAD
expect 0 untouched "$branch" "" "$piped" \
  "1 ADR statuses are valid and match every register (0 changed by this branch)"

# A supersession is a status change, not an acceptance.
fixture superseded
restate superseded "Superseded by ADR-0002"
expect 0 superseded "$branch" "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# And a supersession names the ADR that replaced this one. "Superseded by a
# hallway chat" is a status with no successor to read, and the anchored pattern
# is the only thing standing between the two.
fixture superseded-freehand
restate superseded-freehand "Superseded by a hallway chat"
expect 1 superseded-freehand "$branch" "$adr" "$piped" \
  "status 'Superseded by a hallway chat' is not one of: Proposed, Accepted, or Superseded by ADR-nnnn"

# A successor number is a number, and `SUPERSEDED` was the second place `\d{4}`
# sat beside an ASCII literal: `Superseded by ADR-٠٠٠٩` was a valid status on the
# ADR and in both registers, and the run exited 0. It names a successor that no
# ADR file name can carry, so it points at a decision which cannot exist, while
# reading to a human as `ADR-0009`.
fixture superseded-unicode-digits
restate superseded-unicode-digits "Superseded by ADR-${arabic_indic}"
expect 1 superseded-unicode-digits "$branch" "$adr" "$piped" \
  "status 'Superseded by ADR-${arabic_indic}' is not one of: Proposed, Accepted, or Superseded by ADR-nnnn"

# Rule 1 holds on the trunk too, where rule 2 has nothing to say.
fixture unknown-status
restate unknown-status Draft
expect 1 unknown-status main "$adr" "$piped" \
  "status 'Draft' is not one of: Proposed, Accepted, or Superseded by ADR-nnnn"

fixture no-status
edit no-status/docs/adr/0001-first-decision.md '**Status:** Proposed
' ''
expect 1 no-status main "$adr" "$piped" \
  "no '**Status:**' line in the first 12 lines"

# A register that disagrees with the file is where a stale status is read from.
fixture index-disagrees
edit index-disagrees/docs/adr/README.md 'First decision | Proposed |' 'First decision | Accepted |'
expect 1 index-disagrees main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-missing-row
edit index-missing-row/docs/adr/README.md '| [0001](0001-first-decision.md) | First decision | Proposed |
' ''
expect 1 index-missing-row main "$adr" "$piped" \
  "no row in docs/adr/README.md, so its status is unpoliced there"

fixture index-phantom-row
printf '%s\n' '| [0009](0009-a-renamed-decision.md) | Renamed | Proposed |' \
  >> "$work/index-phantom-row/docs/adr/README.md"
expect 1 index-phantom-row main "$adr" "$piped" \
  "row names 0009-a-renamed-decision.md, which is not in docs/adr"

# A row whose status cell cannot be identified is a parse failure, never a row
# quietly declared correct: guessing is how a wrong status stays invisible.
fixture index-unreadable
edit index-unreadable/docs/adr/README.md 'First decision | Proposed |' 'First decision | Pending |'
expect 1 index-unreadable main "$adr" "$piped" \
  "cannot tell which cell is the status of 0001-first-decision.md"

# The other register. Every case above mutates `docs/adr/README.md`, so with
# only those, dropping `docs/INDEX.md` from `INDEXES` changed nothing and half
# the rule was untested. These two are that half, in both directions.
fixture index2-disagrees
edit index2-disagrees/docs/INDEX.md 'first-decision.md) | Proposed |' 'first-decision.md) | Accepted |'
expect 1 index2-disagrees main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-missing-row
# The row is quoted exactly as `docs/INDEX.md` writes it, backticks included,
# so the fixture keeps the real shape; nothing here is meant to expand.
# shellcheck disable=SC2016
edit index2-missing-row/docs/INDEX.md '| [`adr/0001-first-decision.md`](adr/0001-first-decision.md) | Proposed | API seat | First decision |
' ''
expect 1 index2-missing-row main "$adr" "$piped" \
  "no row in docs/INDEX.md, so its status is unpoliced there"

# A row that means an ADR and gets the name wrong used to be skipped, so a
# register could name a decision that neither exists nor is checked. Rows about
# other documents still are skipped — `docs/INDEX.md` lists every document in
# the repository — which is why the fixture keeps a non-ADR row in it.
fixture index-row-misnamed
printf '%s\n' '| [0009](0009-Realm_Topology.md) | Renamed | Proposed |' \
  >> "$work/index-row-misnamed/docs/adr/README.md"
expect 1 index-row-misnamed main "$adr" "$piped" \
  "this row links to '0009-Realm_Topology.md', which is not an ADR file name"

# The register half of the name defect, and the case that keeps `ADR_SHAPED`
# wider than `ADR_NAME`. A row `ADR_NAME` refuses has to be *named*; narrowing
# `ADR_SHAPED` to `[0-9]+` for symmetry makes this row passed over in silence,
# so a register could name a decision that neither exists nor is checked — the
# hole `[0-9]{4}` closes on the file side, reopened one file over.
fixture index-row-unicode-digits
printf '| [0009](%s-ninth-decision.md) | Ninth decision | Proposed |\n' "$arabic_indic" \
  >> "$work/index-row-unicode-digits/docs/adr/README.md"
expect 1 index-row-unicode-digits main "$adr" "$piped" \
  "this row links to '${arabic_indic}-ninth-decision.md', which is not an ADR file name"

# A row that reports on an ADR without pointing at it. Only the file name at
# the end of the link was kept, so this row was read as the row for
# `0001-first-decision.md` while sending every reader who followed it to a
# different file — one saying `Accepted` beside a decision saying `Proposed`.
# The run exited 0 and printed "1 ADR statuses are valid and match every
# register": a register whose links may go anywhere is not a register.
fixture index-row-redirected
mkdir -p "$work/index-row-redirected/docs/somewhere-else"
printf '%s' '# ADR-0001: First decision

**Status:** Accepted
**Deciders:** the crew
' > "$work/index-row-redirected/docs/somewhere-else/0001-first-decision.md"
edit index-row-redirected/docs/adr/README.md '| [0001](0001-first-decision.md) |' \
  '| [0001](../somewhere-else/0001-first-decision.md) |'
expect 1 index-row-redirected main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this row links to '../somewhere-else/0001-first-decision.md', which resolves to 'docs/somewhere-else/0001-first-decision.md'" \
  "Point it at '0001-first-decision.md'"

# The other register, at the other depth, and the shape a repository-relative
# path takes when it is pasted into a file that is not at the root:
# `docs/INDEX.md` writes `adr/0001-…`, so a row writing `docs/adr/0001-…`
# resolves from inside `docs/` to `docs/docs/adr/0001-…` and lands nowhere at
# all. It exited 0 too. Both registers are covered by one rule — a link read
# from the directory of the register holding it — and this pair is what says so.
fixture index2-row-wrong-depth
edit index2-row-wrong-depth/docs/INDEX.md '](adr/0001-first-decision.md)' \
  '](docs/adr/0001-first-decision.md)'
expect 1 index2-row-wrong-depth main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this row links to 'docs/adr/0001-first-decision.md', which resolves to 'docs/docs/adr/0001-first-decision.md'" \
  "Point it at 'adr/0001-first-decision.md'"

# The register that lives in `docs/adr` indexes `docs/adr`, so a row of it
# pointing outside is named even when nothing of that name is a decision.
# Without this, binding by path would hand back the phantom row the file name
# used to catch: a register could list a decision that is neither there nor
# checked, in silence.
fixture index-row-off-register
printf '%s\n' '| [0009](../drafts/0009-ninth-decision.md) | Ninth decision | Proposed |' \
  >> "$work/index-row-off-register/docs/adr/README.md"
expect 1 index-row-off-register main "$adr" "$piped" \
  "this row links to '../drafts/0009-ninth-decision.md', which resolves to 'docs/drafts/0009-ninth-decision.md'" \
  "every row in the register inside docs/adr is about a decision there"

# The binding is the path a link resolves to, not the string it is written as.
# Either register may write the same ADR the long way round, and a fix that
# compared link text, or matched a leading `adr/`, would redden a register that
# is correct.
fixture index-row-equivalent-path
edit index-row-equivalent-path/docs/adr/README.md '](0001-first-decision.md)' \
  '](./0001-first-decision.md)'
edit index-row-equivalent-path/docs/INDEX.md '](adr/0001-first-decision.md)' \
  '](adr/../adr/0001-first-decision.md)'
expect 0 index-row-equivalent-path main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# `docs/INDEX.md` lists every document in the repository, and a note numbered
# like a decision is still a note. Read by file name, this row was an ADR row
# about a file that is not in `docs/adr`, and it reddened this gate with an ADR
# message; read by where it resolves, it is a row about some other document,
# which is what it always was.
fixture index2-row-not-an-adr
mkdir -p "$work/index2-row-not-an-adr/docs/notes"
printf '# Kickoff notes\n' > "$work/index2-row-not-an-adr/docs/notes/0001-kickoff-notes.md"
# The backticks are how `docs/INDEX.md` writes a path; nothing here expands.
# shellcheck disable=SC2016
printf '%s\n' '| [`notes/0001-kickoff-notes.md`](notes/0001-kickoff-notes.md) | Proposed | Product seat | A note, not a decision |' \
  >> "$work/index2-row-not-an-adr/docs/INDEX.md"
expect 0 index2-row-not-an-adr main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# Four spellings of a row link that a Markdown renderer follows straight to the
# ADR, and that `ROW_LINK` refused: a `#fragment`, a `?query`, `<angle
# brackets>`, and brackets around a fragment. `\.md\)` at the end of the pattern
# missed all four, so the row never reached the classification above — it was
# dropped before anything had decided what it was. Nothing in the thirty-six
# cases before these pinned that either way.
#
# Each is one extra row for a decision that already has a correct one, reading
# `Accepted` beside `Proposed`. Every register keeps every row it had, so no
# other rule has anything to say: on the previous version all eight exited 0
# printing "1 ADR statuses are valid and match every register". Eight and not
# four, because the two registers sit at different depths and write a link
# differently, and a fix to one spelling of one register is not a fix.
fixture index-row-fragment
second_row index-row-fragment readme '0001-first-decision.md#status'
expect 1 index-row-fragment main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-row-query
second_row index-row-query readme '0001-first-decision.md?plain=1'
expect 1 index-row-query main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-row-angle-brackets
second_row index-row-angle-brackets readme '<0001-first-decision.md>'
expect 1 index-row-angle-brackets main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-row-angle-fragment
second_row index-row-angle-fragment readme '<0001-first-decision.md#status>'
expect 1 index-row-angle-fragment main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-fragment
second_row index2-row-fragment index 'adr/0001-first-decision.md#status'
expect 1 index2-row-fragment main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-query
second_row index2-row-query index 'adr/0001-first-decision.md?plain=1'
expect 1 index2-row-query main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-angle-brackets
second_row index2-row-angle-brackets index '<adr/0001-first-decision.md>'
expect 1 index2-row-angle-brackets main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-angle-fragment
second_row index2-row-angle-fragment index '<adr/0001-first-decision.md#status>'
expect 1 index2-row-angle-fragment main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# The other direction, and the case that keeps the eight above honest. Reading
# a decorated link is not the same as refusing one: a "fix" that reddened every
# `#`, `?` or `<` would leave all eight green while breaking a register that is
# correct. Here each register writes its only row for the decision in a
# decorated shape and states the right status, from both depths at once. Green
# proves the row was read and bound to that ADR — a row merely tolerated would
# leave the decision with no row at all, and "no row in docs/adr/README.md" is
# an exit 1.
fixture index-row-decorated-agrees
edit index-row-decorated-agrees/docs/adr/README.md '](0001-first-decision.md)' \
  '](<0001-first-decision.md#status>)'
edit index-row-decorated-agrees/docs/INDEX.md '](adr/0001-first-decision.md)' \
  '](adr/0001-first-decision.md?plain=1)'
expect 0 index-row-decorated-agrees main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# A narrowing has to answer for what it excludes, or it is the silent drop it
# replaced. These two are row links still outside the shapes read — a name with
# no extension, and an angle bracket opened and never closed, which CommonMark
# does not read as a link either. The row is in the register; only its link is
# unreadable. That used to surface as "no row in <register>, so its status is
# unpoliced there", sending a reader to add a row that is already in front of
# them, so the sentence is asserted here rather than the exit code.
fixture index-row-unread-shape
edit index-row-unread-shape/docs/adr/README.md '](0001-first-decision.md)' \
  '](0001-first-decision)'
expect 1 index-row-unread-shape main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this row links to '0001-first-decision', and a row link is not read in that shape" \
  "This row is an ADR row" \
  "Its status was read by nothing"

fixture index2-row-unread-shape
edit index2-row-unread-shape/docs/INDEX.md '](adr/0001-first-decision.md)' \
  '](<adr/0001-first-decision.md)'
expect 1 index2-row-unread-shape main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this row links to '<adr/0001-first-decision.md', and a row link is not read in that shape" \
  "'docs/adr/0001-first-decision.md' is in docs/adr" \
  "Its status was read by nothing"

# And the limit of that. `docs/INDEX.md` indexes every document in the
# repository, most of which are not Markdown at all, so a row link this check
# cannot read is only its business when the link names `docs/adr`. Failing on
# every unread link instead would redden this gate for a row about a compose
# file, which is how a gate gets switched off.
fixture index2-row-unread-elsewhere
# shellcheck disable=SC2016
printf '%s\n' '| [`../compose.yaml`](../compose.yaml) | Proposed | API seat | Local stack |' \
  >> "$work/index2-row-unread-elsewhere/docs/INDEX.md"
expect 0 index2-row-unread-elsewhere main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# CommonMark's *other* link syntax, and the shape that reached none of the
# refusals above. A reference link names a label and keeps the destination in a
# definition elsewhere in the file, so the row holds no `](` at all: `ROW_LINK`
# found nothing, `UNREAD_LINK.findall` returned an empty list, its loop body
# never ran, and the row left `index_rows` through a bare `continue`. Measured on
# this repository's own registers, unmodified check, on the trunk:
#
#     [adr1]: 0001-profile-and-agent-contracts.md
#     | [0001][adr1] | Profile and agent contracts | Accepted |
#     -> 4 ADR statuses are valid and match every register (on 'main')   exit 0
#
# Rendered with tables on, that row and the correct `Proposed` row beside it
# emit the identical `<a href="0001-profile-and-agent-contracts.md">`.
#
# Three spellings escape per register, because CommonMark resolves three:
# `[text][label]` (full), `[label][]` (collapsed) and `[label]` (shortcut). Six
# cases and not three, for the reason the decorated eight above are eight: the
# registers sit at different depths and a fix to one is not a fix.
fixture index-row-reference-full
reference_row index-row-reference-full readme '[0001][adr1]' '[adr1]: 0001-first-decision.md'
expect 1 index-row-reference-full main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-row-reference-collapsed
reference_row index-row-reference-collapsed readme '[0001-first-decision.md][]' \
  '[0001-first-decision.md]: 0001-first-decision.md'
expect 1 index-row-reference-collapsed main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index-row-reference-shortcut
reference_row index-row-reference-shortcut readme '[adr one]' '[adr one]: 0001-first-decision.md'
expect 1 index-row-reference-shortcut main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# The backticks below are how `docs/INDEX.md` writes a path; nothing expands.
# shellcheck disable=SC2016
fixture index2-row-reference-full
# shellcheck disable=SC2016
reference_row index2-row-reference-full index '[`adr/0001-first-decision.md`][adr1]' \
  '[adr1]: adr/0001-first-decision.md'
expect 1 index2-row-reference-full main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# A collapsed label is the bracket run itself, backticks and all — which is what
# a renderer matches against the definition, so it is what is matched here.
fixture index2-row-reference-collapsed
# shellcheck disable=SC2016
reference_row index2-row-reference-collapsed index '[`adr/0001-first-decision.md`][]' \
  '[`adr/0001-first-decision.md`]: adr/0001-first-decision.md'
expect 1 index2-row-reference-collapsed main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-reference-shortcut
reference_row index2-row-reference-shortcut index '[adr one]' '[adr one]: adr/0001-first-decision.md'
expect 1 index2-row-reference-shortcut main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# A definition may carry a title, and the title may be quoted three ways. Only
# the destination is read, so one rule — the first token after the colon — holds
# for every titled form at once, and this case is what says the title does not
# hide the destination behind it.
fixture index-row-reference-titled
reference_row index-row-reference-titled readme '[0001][adr1]' \
  '[adr1]: 0001-first-decision.md "The first decision"'
expect 1 index-row-reference-titled main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# CommonMark matches a label case-insensitively with its internal whitespace
# folded, so `[ADR   One]` and `[adr one]` are one label to a renderer. Folding
# is therefore Unicode-wide here, for the same reason `ADR_SHAPED` is: narrowing
# it would leave a label a renderer resolves unmatched, and an unmatched label in
# the shortcut shape is a row nothing reads.
fixture index-row-reference-folded
reference_row index-row-reference-folded readme '[0001][ADR   One]' \
  '[adr one]: 0001-first-decision.md'
expect 1 index-row-reference-folded main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# A destination may be wrapped in `<angle brackets>` in the definition as well as
# in the row, and a reader that keeps the brackets binds the row to a file name
# with a `<` in it — which is in `docs/adr`, is not an ADR name, is not ADR
# shaped either, and is therefore passed over in silence. The row is dropped and
# the run prints its total, which is this whole file's subject.
fixture index-row-reference-angle-destination
reference_row index-row-reference-angle-destination readme '[0001][adr1]' \
  '[adr1]: <0001-first-decision.md>'
expect 1 index-row-reference-angle-destination main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# And a destination may sit on the line after the colon, which a definition
# reader written one line at a time would miss — a miss that is a dropped row in
# the shortcut shape, where an unmatched label is passed over.
fixture index2-row-reference-wrapped
# shellcheck disable=SC2016
reference_row index2-row-reference-wrapped index '[`adr/0001-first-decision.md`][adr1]' \
  '[adr1]:
    adr/0001-first-decision.md'
expect 1 index2-row-reference-wrapped main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# An undefined label in the full or collapsed shape. Both are unambiguously a
# link attempt, so an undefined one is a broken row in a register whatever it is
# about: it renders as literal text, sends its reader nowhere, and its status was
# compared against nothing. There is no destination to ask `about_adr_dir` about,
# so it is refused in either register rather than guessed at from the label.
fixture index-row-reference-undefined
reference_row index-row-reference-undefined readme '[0001][adr1]'
expect 1 index-row-reference-undefined main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this row links to '[adr1]', and no '[adr1]: <path>' definition in this file gives that label a destination" \
  "renders as literal text"

fixture index2-row-reference-undefined
# shellcheck disable=SC2016
reference_row index2-row-reference-undefined index '[`adr/0001-first-decision.md`][]'
expect 1 index2-row-reference-undefined main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "definition in this file gives that label a destination" \
  "renders as literal text"

# The deliberate limit on the other side, and the reason the two shapes above
# are treated differently from this one. A bare `[label]` with no definition is
# not a link at all — it is a bracketed word, which a table cell may hold for its
# own reasons — so it is passed over. Reddening this gate on every bracketed word
# in a register is how a gate gets switched off, and nothing is lost: a row that
# links nowhere reports on no decision, and a decision whose only row is one gets
# the missing-row failure, which by then says something true.
fixture index2-row-bracketed-text
printf '%s\n' '| [not yet written] | Proposed | API seat | A document with no link |' \
  >> "$work/index2-row-bracketed-text/docs/INDEX.md"
expect 0 index2-row-bracketed-text main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# And the limit that keeps the resolution honest in the other direction: a
# *defined* reference link is classified exactly as an inline one is, so one
# about some other document is passed over exactly as an inline one about some
# other document is. A fix that reddened on every resolved reference row would
# pass every case above while breaking a register that is correct.
fixture index2-row-reference-elsewhere
printf '%s\n' '| [the local stack][compose] | Proposed | API seat | Local stack |' \
  >> "$work/index2-row-reference-elsewhere/docs/INDEX.md"
printf '\n%s\n' '[compose]: ../compose.yaml' \
  >> "$work/index2-row-reference-elsewhere/docs/INDEX.md"
expect 0 index2-row-reference-elsewhere main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# `[text](destination)` is the inline shape and belongs to `ROW_LINK` alone. The
# `(?![\[(])` in `REFERENCE_LINK` is what says so, and this row is what holds it:
# an inline link to a document that is not an ADR, whose link *text* happens to
# spell a label defined elsewhere in the file as the ADR. Without the lookahead
# the bracket run is read a second time as a shortcut, and the row binds to a
# decision it does not point at — the defect `index-row-redirected` exists for,
# arriving through the other syntax. It says `Accepted` so that a wrong binding
# cannot pass unnoticed.
fixture index2-row-inline-not-shortcut
printf '%s\n' '| [adr one](../compose.yaml) | Accepted | API seat | Local stack |' \
  >> "$work/index2-row-inline-not-shortcut/docs/INDEX.md"
printf '\n%s\n' '[adr one]: adr/0001-first-decision.md' \
  >> "$work/index2-row-inline-not-shortcut/docs/INDEX.md"
expect 0 index2-row-inline-not-shortcut main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# Raw HTML, refused rather than read, in both registers. `<a href="0001-…md">`
# renders to the same `<a>` element the Markdown row beside it renders to and
# carries neither `](` nor a bracket run, so every pattern here misses it.
# Reading it would mean an HTML attribute parser — quoting, character
# references, attribute order — and each spelling it did not cover would be
# classified as "some other document" and dropped, which is the silence this
# commit exists to end, bought again for a shape neither register uses. It is
# refused whatever the href points at, because deciding that first would mean
# reading the href, and a partial read is worse than none.
fixture index-row-html-anchor
printf '%s\n' '| <a href="0001-first-decision.md">0001</a> | First decision | Accepted |' \
  >> "$work/index-row-html-anchor/docs/adr/README.md"
expect 1 index-row-html-anchor main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this row links in raw HTML" \
  "that is the one shape this check reads, and a row it does not read is a row whose status nothing compares"

fixture index2-row-html-anchor
printf '%s\n' '| <a href="adr/0001-first-decision.md">0001</a> | Accepted | API seat | First decision |' \
  >> "$work/index2-row-html-anchor/docs/INDEX.md"
expect 1 index2-row-html-anchor main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this row links in raw HTML"

# The second symptom, one register at a time: where the reference-style row is
# the decision's *only* row, the run said "no row in <register>, so its status is
# unpoliced there" — verbatim the sentence `refuse_unread_link` was added to stop
# saying, about a register the row is plainly sitting in. The row is read now, so
# the disagreement in it is what gets named.
fixture index-row-reference-sole-row
edit index-row-reference-sole-row/docs/adr/README.md \
  '| [0001](0001-first-decision.md) | First decision | Proposed |' \
  '| [0001][adr1] | First decision | Accepted |'
printf '\n%s\n' '[adr1]: 0001-first-decision.md' \
  >> "$work/index-row-reference-sole-row/docs/adr/README.md"
expect 1 index-row-reference-sole-row main "$adr" "$piped" \
  "file=docs/adr/README.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

fixture index2-row-reference-sole-row
# shellcheck disable=SC2016
edit index2-row-reference-sole-row/docs/INDEX.md \
  '| [`adr/0001-first-decision.md`](adr/0001-first-decision.md) | Proposed |' \
  '| [adr one] | Accepted |'
printf '\n%s\n' '[adr one]: adr/0001-first-decision.md' \
  >> "$work/index2-row-reference-sole-row/docs/INDEX.md"
expect 1 index2-row-reference-sole-row main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"

# The green case the sixteen above are measured against, and the one that keeps
# them honest the way `index-row-decorated-agrees` keeps the decorated eight
# honest. Each register writes its only row for the decision as a reference link
# — full with a titled definition from `docs/adr`, shortcut under a differently
# cased and spaced label from `docs` — and states the right status. Green proves
# the row was *bound* and not merely tolerated: a tolerated row leaves the
# decision with no row at all, and "no row in docs/adr/README.md" is an exit 1,
# which is exactly the sentence this whole group exists to retire.
fixture index-row-reference-agrees
edit index-row-reference-agrees/docs/adr/README.md \
  '| [0001](0001-first-decision.md) | First decision | Proposed |' \
  '| [0001][adr1] | First decision | Proposed |'
printf '\n%s\n' '[adr1]: 0001-first-decision.md "The first decision"' \
  >> "$work/index-row-reference-agrees/docs/adr/README.md"
# shellcheck disable=SC2016
edit index-row-reference-agrees/docs/INDEX.md \
  '| [`adr/0001-first-decision.md`](adr/0001-first-decision.md) |' \
  '| [first decision] |'
printf '\n%s\n' '[First   Decision]: adr/0001-first-decision.md' \
  >> "$work/index-row-reference-agrees/docs/INDEX.md"
expect 0 index-row-reference-agrees main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# Reference destinations must normalize like inline destinations. Each positive
# replaces the sole row, so silently skipping it cannot pass. Its negative twin
# appends a disagreeing row and asserts the status error, not an incidental
# malformed-filename error. Cover each shape, wrapper and register depth.
for register in readme index; do
  file=docs/adr/README.md
  destination=0001-first-decision.md
  [ "$register" = readme ] || { file=docs/INDEX.md; destination=adr/0001-first-decision.md; }
  for shape in full collapsed shortcut; do
    case "$shape" in
      full) reference='[0001][decision]' ;;
      collapsed) reference='[decision][]' ;;
      shortcut) reference='[decision]' ;;
    esac
    for suffix in '#context' '?plain=1' '?plain=1#context'; do
      for wrapper in bare angle; do
        case_name="reference-decorated-$register-$shape-$wrapper-${suffix//[^a-z0-9]/}"
        written="$destination$suffix"
        [ "$wrapper" = bare ] || written="<$written>"
        fixture "$case_name"
        # The first register uses a number label; the second uses a code span.
        if [ "$register" = readme ]; then
          edit "$case_name/$file" "[0001]($destination)" "$reference"
        else
          edit "$case_name/$file" "[\`$destination\`]($destination)" "$reference"
        fi
        printf '\n[decision]: %s\n' "$written" >> "$work/$case_name/$file"
        expect 0 "$case_name" main "$adr" "$piped" \
          "1 ADR statuses are valid and match every register"

        fixture "$case_name-disagrees"
        reference_row "$case_name-disagrees" "$register" "$reference" "[decision]: $written"
        expect 1 "$case_name-disagrees" main "$adr" "$piped" \
          "file=$file" \
          "this register says 0001-first-decision.md is 'Accepted'; the file says 'Proposed'"
      done
    done
  done
  for suffix in '#context' '?plain=1'; do
    case_name="reference-wrong-target-$register-${suffix//[^a-z0-9]/}"
    fixture "$case_name"
    reference_row "$case_name" "$register" '[0001][decision]' \
      "[decision]: ../elsewhere/0001-first-decision.md$suffix"
    expect 1 "$case_name" main "$adr" "$piped" \
      "file=$file" "which resolves to" "Point it at"

    case_name="reference-missing-target-$register-${suffix//[^a-z0-9]/}"
    fixture "$case_name"
    reference_row "$case_name" "$register" '[0009][decision]' \
      "[decision]: ${destination/0001-first/0009-ninth}$suffix"
    expect 1 "$case_name" main "$adr" "$piped" \
      "file=$file" "row names 0009-ninth-decision.md, which is not in docs/adr"
  done
done

# A directory whose name merely begins with `docs/adr` is a different
# directory. `dirname(target) != ADR_DIR` written as a `startswith` reads
# `docs/adrs/…` — and `docs/adr/drafts/…` — as rows about decisions, and
# reddens this gate over a document that is not one.
fixture index2-row-adjacent-dir
printf '%s\n' '| [0009](adrs/0009-ninth-decision.md) | Proposed | API seat | Not a decision |' \
  >> "$work/index2-row-adjacent-dir/docs/INDEX.md"
expect 0 index2-row-adjacent-dir main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# Two cells that both read as a status is a row whose status cannot be told,
# and `len(statuses) != 1` is what says so. Relaxed to `< 1` it takes the first
# and calls the row read, so a register could carry a second status nobody
# compares. The existing `index-unreadable` case has *no* readable cell, so `< 1`
# leaves it green; this is the other side, and on the other register.
fixture index2-row-two-statuses
edit index2-row-two-statuses/docs/INDEX.md 'API seat | First decision |' \
  'API seat | Accepted |'
expect 1 index2-row-two-statuses main "$adr" "$piped" \
  "file=docs/INDEX.md" \
  "cannot tell which cell is the status of 0001-first-decision.md"

# Prose that links to an ADR is prose. `line.startswith("|")` is the whole of
# that rule, and dropping it turns every sentence carrying a link into a row
# with no status cell to find — a register reddened for containing a paragraph.
fixture index-row-prose-link
printf '%s\n' 'See [0001](0001-first-decision.md) for the first decision.' \
  >> "$work/index-row-prose-link/docs/adr/README.md"
expect 0 index-row-prose-link main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# The name shapes. Each was a ninth decision the check did not read, did not
# count and did not mention, under a run that printed a total. The first two
# were caught by the `*.md` glob; the three after them were not, because the
# glob answered "no such entry" for a name it was not written to match.
fixture stray-capitalised
stray stray-capitalised 0009-Realm_Topology.md Accepted
expect 1 stray-capitalised "$branch" "$adr" "$piped" \
  "'0009-Realm_Topology.md' is in docs/adr but is not an ADR file name"

fixture stray-five-digit
stray stray-five-digit 00010-realm-topology.md Accepted
expect 1 stray-five-digit "$branch" "$adr" "$piped" \
  "'00010-realm-topology.md' is in docs/adr but is not an ADR file name"

fixture stray-no-status
stray stray-no-status 0009-A_New_Decision.md ""
expect 1 stray-no-status "$branch" "$adr" "$piped" \
  "'0009-A_New_Decision.md' is in docs/adr but is not an ADR file name"

fixture stray-no-extension
stray stray-no-extension 0009-ninth-decision Accepted
expect 1 stray-no-extension "$branch" "$adr" "$piped" \
  "'0009-ninth-decision' is in docs/adr but is not an ADR file name" \
  "then '.md'"

fixture stray-markdown
stray stray-markdown 0009-ninth-decision.markdown Accepted
expect 1 stray-markdown "$branch" "$adr" "$piped" \
  "'0009-ninth-decision.markdown' is in docs/adr but is not an ADR file name"

fixture stray-txt
stray stray-txt 0009-ninth-decision.txt Accepted
expect 1 stray-txt "$branch" "$adr" "$piped" \
  "'0009-ninth-decision.txt' is in docs/adr but is not an ADR file name"

# The shape that walked through the name pattern itself, in three scripts. Each
# is a ninth decision under a second spelling of a number that already has one:
# beside a real `0009-…`, both listed in both registers, both rendering as
# `| [0009](…) |`, the previous version scanned two decisions and printed "3 ADR
# statuses are valid and match every register". Three blocks rather than one,
# because the defect is the width of a character class and not any one
# character: a fix that special-cased Arabic-Indic would leave the other two.
fixture stray-unicode-digits
stray stray-unicode-digits "${arabic_indic}-ninth-decision.md" Accepted
stray stray-unicode-digits "${nko}-ninth-decision.md" Accepted
stray stray-unicode-digits "${fullwidth}-ninth-decision.md" Accepted
expect 1 stray-unicode-digits "$branch" "$adr" "$piped" \
  "'${arabic_indic}-ninth-decision.md' is in docs/adr but is not an ADR file name" \
  "'${nko}-ninth-decision.md' is in docs/adr but is not an ADR file name" \
  "'${fullwidth}-ninth-decision.md' is in docs/adr but is not an ADR file name"

# A real subdirectory now fails on the directory entry itself rather than on
# what happens to be inside it, so an empty one fails too.
fixture stray-subdirectory
stray stray-subdirectory drafts/0009-realm-topology.md Accepted
expect 1 stray-subdirectory "$branch" "$adr" "$piped" \
  "'drafts' is a directory inside docs/adr"

# The shape `rglob` walks straight past: it does not descend into a symbolic
# link, so the decision inside this one was neither read nor named.
fixture stray-symlinked-dir
mkdir -p "$work/stray-symlinked-dir/elsewhere"
stray stray-symlinked-dir ../../elsewhere/0009-realm-topology.md Accepted
ln -s "$work/stray-symlinked-dir/elsewhere" "$work/stray-symlinked-dir/docs/adr/drafts"
expect 1 stray-symlinked-dir "$branch" "$adr" "$piped" \
  "'drafts' in docs/adr is a symbolic link"

# A link whose name and target are both valid, and which both registers list,
# so nothing else in the check has anything to say about it. It is refused
# because it is a second register-visible identity for ADR-0001; the previous
# version scanned it as a ninth decision and reported "2 ADR statuses".
fixture stray-symlinked-adr
ln -s 0001-first-decision.md \
  "$work/stray-symlinked-adr/docs/adr/0009-ninth-decision.md"
list_ninth stray-symlinked-adr 0009-ninth-decision.md
expect 1 stray-symlinked-adr "$branch" "$adr" "$piped" \
  "'0009-ninth-decision.md' in docs/adr is a symbolic link"

# Neither a file nor a directory: there is no status in it to read, and a check
# that read it would block on the open.
fixture stray-not-a-file
mkfifo "$work/stray-not-a-file/docs/adr/0009-ninth-decision.md"
list_ninth stray-not-a-file 0009-ninth-decision.md
expect 1 stray-not-a-file "$branch" "$adr" "$piped" \
  "'0009-ninth-decision.md' in docs/adr is not a regular file"

# The template and the register itself are the two files in that directory that
# are not decisions, and neither may be mistaken for a stray.
fixture template-and-register
expect 0 template-and-register main "$adr" "$piped" \
  "1 ADR statuses are valid and match every register"

# Listing a directory that is not there must say so, not raise.
fixture no-adr-dir
rmdir "$work/no-adr-dir/docs/adr" 2>/dev/null || mv "$work/no-adr-dir/docs/adr" "$work/no-adr-dir/gone"
expect 1 no-adr-dir main "" "$piped" \
  "no ADR files found"

# Off the trunk with no changed-file list, the check refuses rather than guess.
fixture no-list
restate no-list Accepted
expect 1 no-list "$branch" "$adr" - \
  "refusing to guess which ADRs this branch changed"

echo "self-test passed: a premature acceptance, an unknown, missing or freehand"
echo "status, either register disagreeing, omitting a row, naming a file that is"
echo "not there or reporting on an ADR without pointing at it — from either"
echo "register's own depth — a row whose link carries a fragment, a query"
echo "string, angle brackets or brackets around a fragment, one written as a"
echo "reference link in any of the three shapes a renderer resolves, against a"
echo "definition carrying a title, wrapping its destination in angle brackets,"
echo "holding it on the next line or spelling its label under another case, one"
echo "whose reference label is defined nowhere, one that links in raw HTML, and"
echo "one written in a shape not read at all, a row with two cells that read as"
echo "a status, a decision misnamed, unsuffixed, suffixed wrongly, parked in a"
echo "subdirectory real or symlinked, linked to under a second name, numbered in"
echo "digits from another script — in its own name, in a register row, or as the"
echo "successor of a supersession — left as something other than a regular file, a"
echo "missing ADR directory, and a caller who piped no changed files are all"
echo "caught; a merged flip, an untouched ADR, a link written the long way"
echo "round, decorated or written as a reference link but agreeing, a bracketed"
echo "word that is nobody's label, a resolved reference row about some other"
echo "document, an inline link whose text spells a defined label, a row about a"
echo "document that is not a decision — under a directory whose name merely"
echo "begins like docs/adr, or with a link this check does not read — and a"
echo "sentence of prose that links to an ADR are not; every case asserts the"
echo "sentence it is caught with; bare acceptance without merged-proposal"
echo "evidence stays refused. Git-backed ratification cases follow."

python3 "$here/check-adr-ratification.selftest.py"

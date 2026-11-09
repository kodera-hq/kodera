#!/usr/bin/env bash
# Proves the alert-parity self-test is bound to the check, one clause at a time.
#
# `check-alert-parity.selftest.sh` proves the check can fail. It does not prove
# the check is still doing the work: delete a rule and the suite would go on
# reporting forty-three green cases if no case depended on that rule alone. So
# every mutation below removes exactly one clause of the check and asserts two
# things — the suite refuses, and it refuses **at the case that owns the
# clause**. The second half is the part that matters. A mutation caught by some
# unrelated case further down proves only that the suite is noisy; this repo has
# already shipped a check whose three candidate discriminators were each
# plausible and each wrong, and a suite that cannot say which case caught what
# is how that happens.
#
# What is *not* here is listed at the end rather than left out. Four refusals in
# the check are unreachable by any mutation, because a refusal that always fires
# first says the same thing; a redundant clause cannot be proven by mutating it
# alone, and dressing one up with a fixture only tests the shadowing clause
# twice. All four were mutated to `pass` and the suite went on passing, which is
# how they are known to be redundant rather than assumed to be. They are named
# in `REDUNDANT` below, with what shadows them, so the next reader does not have
# to rediscover it.

# The replacement strings below are fragments of Python quoted exactly as
# `check-alert-parity.py` writes them. Nothing in them is meant to expand.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
check="$here/check-alert-parity.py"
selftest="$here/check-alert-parity.selftest.sh"

for f in "$check" "$selftest"; do
  [ -f "$f" ] || { echo "mutation probe FAILED: $f is missing" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/alert-parity-mutations.XXXXXX")"
trap 'rm -rf "$work"' EXIT
caught=0

# The baseline. Without it, every refusal below could be the tree rather than
# the mutation, and the whole file would prove nothing.
echo "alert-parity mutation probe"
mkdir -p "$work/baseline/.github/scripts"
cp -R "$root/docs" "$work/baseline/docs"
cp "$check" "$selftest" "$work/baseline/.github/scripts/"
if ! bash "$work/baseline/scripts/ci/check-alert-parity.selftest.sh" > "$work/baseline.out" 2>&1; then
  echo "mutation probe FAILED: the unmutated suite does not pass" >&2
  cat "$work/baseline.out" >&2
  exit 1
fi
printf '  ok  %-28s the unmutated suite passes\n' "baseline"

# mutate <label> <case> <old> <new>
#
# <case> is the self-test case that must be the one to refuse. The suite stops
# at its first failure and names it, so "the suite went red" and "this case went
# red" are distinguishable — and only the second is evidence about this clause.
mutate() {
  local label="$1" case="$2" old="$3" new="$4" dir="$work/$1" out got=0
  mkdir -p "$dir/.github/scripts"
  cp -R "$root/docs" "$dir/docs"
  cp "$check" "$selftest" "$dir/.github/scripts/"

  python3 - "$dir/scripts/ci/check-alert-parity.py" "$old" "$new" <<'PY'
import sys

path, old, new = sys.argv[1:4]
with open(path, encoding="utf-8") as handle:
    body = handle.read()
count = body.count(old)
if count != 1:
    sys.exit(f"mutation probe is broken: {old!r} appears {count} times in {path}, wanted 1")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(body.replace(old, new, 1))
PY

  # A mutation that only breaks the syntax fails every case at once, including
  # `clean` — which would read as proof for any clause declared to `clean`. The
  # mutated check has to still be a program.
  if ! python3 -m py_compile "$dir/scripts/ci/check-alert-parity.py" 2>/dev/null; then
    echo "mutation probe is broken: '$label' does not compile; it proves nothing" >&2
    exit 1
  fi

  out="$(bash "$dir/scripts/ci/check-alert-parity.selftest.sh" 2>&1)" || got=$?
  if [ "$got" -eq 0 ]; then
    echo "mutation probe FAILED: '$label' survived — the suite passed with that clause removed." >&2
    echo "  no case depends on it, so deleting it from the check would go unnoticed." >&2
    exit 1
  fi
  if ! printf '%s\n' "$out" | grep -qF -- "self-test FAILED: '$case'"; then
    echo "mutation probe FAILED: '$label' was caught, but not by '$case'." >&2
    echo "  A clause proven only by an unrelated case is a clause nobody owns." >&2
    printf '%s\n' "$out" | tail -20 >&2
    exit 1
  fi
  caught=$((caught + 1))
  printf '  ok  %-28s caught by %s\n' "$label" "$case"
}

# ------------------------------------------------------------------- rule 1
mutate scope-exception-severity watchdog-has-severity \
  'if cell not in ("—", "-", ""):' \
  'if False:'

mutate scope-exception-paged watchdog-listed \
  'elif name in paging:' \
  'elif False:'

mutate scope-unpaged-alert severity-disagrees-slo \
  '        if name not in paging:' \
  '        if False:'

mutate scope-phantom-row paging-row-phantom \
  'for name, (line, severity) in sorted(paging.items()):
        if name not in alerts:' \
  'for name, (line, severity) in sorted(paging.items()):
        if False:'

# ------------------------------------------------------------- rules 2 and 3
mutate severity-cell-shape second-severityless \
  'if not bare and not both:' \
  'if False:'

mutate severity-parity severity-disagrees \
  'if base != severity:' \
  'if False:'

mutate escalation-unlisted-row escalation-unlisted \
  'if name not in escalations:' \
  'if False:'

mutate escalation-pair-parity escalation-mismatched \
  'if (listed_base, listed_into) != (base, int(both.group(2))):' \
  'if False:'

mutate escalation-spurious-row escalation-spurious \
  'elif name in escalations:' \
  'elif False:'

mutate escalation-cell-shape escalation-cell-malformed \
  'if not base or not into:' \
  'if False:'

# ------------------------------------------------------------------- rule 4
mutate grain-unstated-grouping grain-unstated \
  'if not grouping:' \
  'if False:'

mutate grain-undeclared-label entity-undeclared \
  'if label not in labels:' \
  'if False:'

mutate grain-missing-prose-row hard-down-row-lost \
  'if name not in hard_down:' \
  'if False:'

mutate grain-prose-has-no-threshold grain-prose-vague \
  '        stated = PROSE_COUNT.search(condition)
        if not stated:' \
  '        stated = PROSE_COUNT.search(condition)
        if False:'

mutate grain-threshold-parity grain-threshold \
  'if int(stated.group(1)) != wanted:' \
  'if False:'

mutate grain-strictness grain-strict-boundary \
  "wanted = int(threshold.group(2)) + (threshold.group(1) == \">\")" \
  'wanted = int(threshold.group(2))'

mutate grain-unknown-noun grain-prose-noun \
  '        if noun not in nouns:
            error(
                SLO,' \
  '        if False:
            error(
                SLO,'

mutate grain-noun-label-parity grain-disagrees \
  'elif nouns[noun] != label:
            error(
                STACK,' \
  'elif False:
            error(
                STACK,'

mutate grain-rule-binds-nothing no-fleet-count \
  'if bound == 0:' \
  'if False:'

# ------------------------------------------------------------------- rule 5
mutate prose-alert-name-gate clean \
  'if not re.search(rf"\b{re.escape(name)}\b", line):
                    continue' \
  'if False:
                    continue'

mutate prose-history-skip restated-history-exempt \
  'if in_history:
                continue' \
  'if False:
                continue'

mutate prose-history-ends-at-heading restated-after-history \
  'in_history = bool(HISTORY_HEADING.match(raw))' \
  'in_history = in_history or bool(HISTORY_HEADING.match(raw))'

mutate prose-count-parity restated-number \
  'if count != wanted:' \
  'if False:'

mutate prose-unknown-noun restated-noun-unknown \
  '                if noun not in nouns:
                    error(
                        relative,' \
  '                if False:
                    error(
                        relative,'

mutate prose-noun-label-parity restated-noun \
  'elif nouns[noun] != label:
                    error(
                        relative,' \
  'elif False:
                    error(
                        relative,'

# Owned by `clean`, not by `restated-adr-exempt`, and the distinction is worth
# stating: `clean` counts the corpus itself with `find -path docs/adr -prune`
# and asserts the number, so any widening of the sweep moves a number it derived
# without asking the check. `restated-adr-exempt` says what the exemption is
# *for* — the ADR it plants a bad threshold in would otherwise refuse — and it
# would catch this too, one case later. The scope is what binds here.
mutate prose-adr-exemption clean \
  'if exempt not in path.parents and path != exempt' \
  'if True or (exempt not in path.parents and path != exempt)'

mutate prose-sweep-is-recursive clean \
  'directory.rglob("*.md")' \
  'directory.glob("*.md")'

# Both halves of RESTATED's narrowness are owned by `clean`, and that is the
# right answer rather than a weaker one: the real tree already contains both
# traps. §6's catalogue row carries `>= 3` inside a PromQL cell, and §3.2 says
# "three or more tenants" in a sentence that is about upgrades, not alerting.
# Widen the pattern in either direction and the documents this check is silent
# on start refusing. `restated-not-a-threshold` plants the same two shapes next
# to an alert name to say so out loud; it is a statement of intent standing
# behind `clean`, not an independent proof — see REDUNDANT below.
mutate prose-threshold-needs-a-noun clean \
  'r")\s+or\s+more)\s+([a-z]+)"' \
  'r")\s+or\s+more)\s*([a-z]*)"'

mutate prose-bare-count-is-not-a-threshold clean \
  'r"(?:(?:>=|≥)\s*(\d+)|\b("' \
  'r"(?:(?:>=|≥)?\s*(\d+)|\b("'

# ---------------------------------------------------- the vocabulary and parse
mutate entity-plural-noun clean \
  'nouns[entity + "s"] = label' \
  'pass'

mutate catalogue-duplicate-row duplicate-catalogue-row \
  'if name.group(1) in alerts:' \
  'if False:'

mutate catalogue-row-arity catalogue-row-truncated \
  'if len(cells) < 4:' \
  'if False:'

mutate paging-duplicate-row duplicate-paging-row \
  'if name in where:' \
  'if False:'

mutate section-missing-is-a-refusal no-label-table \
  '    if start is None:
        raise ReadError' \
  '    if start is None:
        return []
    if False:
        raise ReadError'

mutate unreadable-tree-is-a-refusal no-documents \
  'except OSError as exc:
        print(f"::error::{exc}")
        return 1' \
  'except OSError as exc:
        print(f"::error::{exc}")
        return 0'

mutate unparsable-table-is-a-refusal escalation-cell-malformed \
  'except ReadError as exc:
        print(f"::error::{exc}")
        return 1' \
  'except ReadError as exc:
        print(f"::error::{exc}")
        return 0'

# The exit status is the only bit CI consumes, and asserting the message alone
# has let a refusal be flipped to a pass in this repository before.
mutate failure-count-is-a-refusal grain-disagrees \
  '    if failures:
        return 1' \
  '    if failures:
        return 0'

# ----------------------------------------------------------------- redundancy
#
# Clauses that a mutation cannot reach, each because a clause that always fires
# first says the same thing. Recorded rather than dressed up with a fixture that
# would only be testing the shadowing clause a second time. If either of the
# clauses named on the right is ever removed, the one on the left becomes
# reachable and belongs above.
REDUNDANT="\
  all_rows_under's 'no section matching' refusal — shadowed by catalogue()'s
    'no alert rows found under §6'. Its only caller treats an empty section
    list and an empty row list identically, so both arrive as one message.
  declared_labels', paging_rows' and hard_down_rows' 'no rows found' refusals —
    shadowed by rows_under's 'no section matching'. On these documents a table
    is only ever empty because its heading is gone, and that refuses first.
  Each of the four was mutated to 'pass' on 2026-09-12 and the suite still
  passed all 43 cases. They are defensive, not dead: a document shaped so that
  a section exists and its table does not would reach them.

  One self-test CASE is redundant in the same sense: restated-not-a-threshold.
  Both halves of RESTATED's narrowness are owned by 'clean', because the real
  documents already contain the two shapes the case plants. It is kept as a
  statement of intent about prose the check must not judge, not as a proof."

# `caught` counts what ran; `declared` counts what this file asks for, read back
# out of the file rather than out of the loop that just executed. They differ
# only if a `mutate` line stopped being reached — an `exit` or a `return` slipped
# in above it — which is the one way this probe could go quiet while passing.
declared="$(grep -c '^mutate ' "${BASH_SOURCE[0]}")"
if [ "$caught" -ne "$declared" ]; then
  echo "mutation probe FAILED: $declared mutations are written here and $caught ran" >&2
  exit 1
fi

# Every case in the suite should be the owner of something. A case that owns no
# clause is not wrong, but it is not evidence either, and this prints the list
# so the gap is visible rather than assumed away.
suite="$(grep -cE '^expect [01] ' "$here/check-alert-parity.selftest.sh")"
owners="$(grep -oE '^mutate [a-z0-9-]+ [a-z0-9-]+' "${BASH_SOURCE[0]}" | awk '{print $3}' | sort -u | wc -l | tr -d '[:space:]')"

echo
echo "mutation probe: $caught of $declared clauses of check-alert-parity.py removed"
echo "one at a time, each caught by the self-test case that owns it; the unmutated"
echo "suite passes. $owners of the suite's $suite cases own a clause outright."
echo "Clauses no mutation can reach, and why:"
printf '%s\n' "$REDUNDANT"

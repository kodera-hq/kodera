#!/usr/bin/env bash
# Proves the realm-topology self-test is bound to the check, one clause at a time.
#
# `check-realm-topology.selftest.sh` proves the check can fail. It does not prove
# the check is still doing the work: remove a rule, or the binding that makes an
# allowlist entry cost something, and every case would go on passing if none
# depended on that clause alone. So every mutation below removes exactly one
# clause and asserts two things — the suite refuses, and it refuses **at the case
# that owns the clause**. Its case count is not repeated here, because a number
# written in prose beside a suite that grows is a number that goes wrong; the
# probe counts the suite itself and prints the figure at the end.
#
# The second half is what makes this more than noise. The allowlist is the part
# of this check that has to be hard to lie to: an earlier register elsewhere in
# this workspace enforced only that a `reason` key was present, so any string
# bought an exemption. The bindings below — path, line, rule, exact text, and a
# structural condition per reason — are what replaced that, and each one is
# mutated here separately so that none of them can quietly stop being enforced.

# The replacement strings are fragments of Python quoted exactly as
# `check-realm-topology.py` writes them. Nothing in them is meant to expand.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/check-realm-topology.py"
selftest="$here/check-realm-topology.selftest.sh"

for f in "$check" "$selftest"; do
  [ -f "$f" ] || { echo "mutation probe FAILED: $f is missing" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/realm-topology-mutations.XXXXXX")"
trap 'rm -rf "$work"' EXIT
caught=0

echo "realm-topology mutation probe"
mkdir -p "$work/baseline/scripts/ci"
cp "$check" "$selftest" "$work/baseline/scripts/ci/"
if ! bash "$work/baseline/scripts/ci/check-realm-topology.selftest.sh" > "$work/baseline.out" 2>&1; then
  echo "mutation probe FAILED: the unmutated suite does not pass" >&2
  cat "$work/baseline.out" >&2
  exit 1
fi
printf '  ok  %-34s the unmutated suite passes\n' "baseline"

# mutate <label> <case> <old> <new>
#
# <case> is the self-test label that must be the one to refuse. The suite stops
# at its first failure and names it, so "the suite went red" and "this case went
# red" are distinguishable, and only the second is evidence about this clause.
mutate() {
  local label="$1" case="$2" old="$3" new="$4" dir="$work/$1" out got=0
  mkdir -p "$dir/scripts/ci"
  cp "$check" "$selftest" "$dir/scripts/ci/"

  python3 - "$dir/scripts/ci/check-realm-topology.py" "$old" "$new" <<'PY'
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

  # A mutation that only breaks the syntax fails every case at once, which would
  # read as proof for whichever case happens to run first. It has to compile.
  if ! python3 -m py_compile "$dir/scripts/ci/check-realm-topology.py" 2>/dev/null; then
    echo "mutation probe is broken: '$label' does not compile; it proves nothing" >&2
    exit 1
  fi

  out="$(bash "$dir/scripts/ci/check-realm-topology.selftest.sh" 2>&1)" || got=$?
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
  printf '  ok  %-34s caught by %s\n' "$label" "$case"
}

# ------------------------------------------------------------- the rule set
#
# `realm-per-tenant` is four patterns, and the longest of them swallows the
# others wherever they overlap, so each needs a sentence only it can see or
# three quarters of the rule could be deleted unnoticed. That was true of this
# suite as it arrived: `one realm per tenant, in prose` owned pattern three and
# nothing owned the rest.
mutate rule-bare-realm-per-tenant 'a realm per tenant, without the word one' \
  'NOT_ALNUM_BEFORE + r"realms?[\s_-]per[\s_-]tenants?" + NOT_ALNUM_AFTER,' \
  'NOT_ALNUM_BEFORE + r"realms?[\s_-]per[\s_-]zzzzzz" + NOT_ALNUM_AFTER,'

mutate rule-per-tenant-realm 'the phrase used as an adjective, reversed' \
  'NOT_ALNUM_BEFORE + r"per[\s_-]tenant[\s_-]realms?" + NOT_ALNUM_AFTER,' \
  'NOT_ALNUM_BEFORE + r"per[\s_-]tenant[\s_-]zzzzzz" + NOT_ALNUM_AFTER,'

mutate rule-one-realm-for-each-tenant 'one realm per tenant, in prose' \
  'r"one\s+realm\s+(?:for|per)\s+(?:each\s+|every\s+|a\s+|the\s+)?tenants?"' \
  'r"one\s+realm\s+(?:for|per)\s+(?:each\s+|every\s+|a\s+|the\s+)?zzzzzz"'

mutate rule-tenant-has-a-realm 'the claim made with a verb instead of a preposition' \
  'r"(?:each|every)\s+tenant\s+(?:has|gets|owns|carries|keeps)"' \
  'r"(?:each|every)\s+tenant\s+(?:has|gets|zzzzzz|carries|keeps)"'

mutate rule-tenant-owned-realm 'the realm described as the tenant'"'"'s' \
  "NOT_ALNUM_BEFORE + r\"tenants?(?:['’]s|s['’])?[\\s_-]realms?\" + NOT_ALNUM_AFTER," \
  "NOT_ALNUM_BEFORE + r\"tenants?(?:['’]s|s['’])?[\\s_-]zzzzzz\" + NOT_ALNUM_AFTER,"

# The adjective hole: "the tenant's realm" was found and "the tenant's own
# Keycloak realm" walked past, which is a hole and not a rewording.
mutate rule-possessive-adjective 'an adjective between possessive and noun' \
  "r\"(?:\\s+[A-Za-z]+)?\\s+realms?\" + NOT_ALNUM_AFTER," \
  "r\"(?:\\s+[A-Za-z]+)?\\s+zzzzzz\" + NOT_ALNUM_AFTER,"

# Three patterns again, and each arrives in a different kind of file: a JSON
# fixture, a configuration key, a discovery URL. Anchored on quote-free
# fragments so the shell does not have to carry the pattern's own quoting.
mutate rule-realm-key-in-json 'a realm fixture named from a tenant slug' \
  ']realm[' \
  ']zzzzzz['

mutate rule-realm-key-in-config 'a realm named from a tenant in configuration' \
  'realms?\s*[:=]' \
  'zzzzzz?\s*[:=]'

mutate rule-realm-in-url 'a realm named from a tenant in a discovery URL' \
  '/realms/tenant[-_]' \
  '/zzzzzz/tenant[-_]'

# The leading lookaround does two jobs, and they need separate mutations because
# they fail in opposite directions.
#
# One: `\b` is the wrong boundary here, because an underscore is a word
# character and `\btenant` therefore never matches inside
# KEYCLOAK_DEV_TENANT_REALMS — the one executable statement of the topology,
# which a check written the obvious way walks straight past.
mutate boundary-underscore-is-not-a-word-break 'the phrase inside a SCREAMING_SNAKE name' \
  'NOT_ALNUM_BEFORE = r"(?<![A-Za-z0-9])"' \
  'NOT_ALNUM_BEFORE = r"\b"'

# Two: something has to be there at all, or `multitenant realm` reads as
# `tenant realm` and the next reader silences the check instead of the
# statement. Dropping the lookaround passes the case above and fails this one.
mutate boundary-requires-a-non-alnum-before 'a word that merely ends in tenant' \
  'NOT_ALNUM_BEFORE = r"(?<![A-Za-z0-9])"' \
  'NOT_ALNUM_BEFORE = r""'

# And the trailing lookaround, which is the same idea at the other end of the
# phrase: `realmUpdate` is an identifier that merely begins with the noun, and
# camelCase is documented as out of this scanner's reach.
mutate boundary-not-alnum-after 'an identifier that merely begins with realm' \
  'NOT_ALNUM_AFTER = r"(?![A-Za-z0-9])"' \
  'NOT_ALNUM_AFTER = r""'

# Two patterns of the same rule often see the same sentence — "one realm per
# tenant" contains "realm per tenant" — and that is one statement, not two. The
# cases that own this assert the COUNT and not only the message, which is the
# only way a de-duplication bug is visible at all.
#
# Only the containment test is mutated here. Its companion, the sort that puts
# the longest hit first, is unreachable: it is a tiebreaker on equal start
# offsets, and no two patterns in the current rule set can match at the same
# offset — every overlap in this tree starts at a different character, where the
# primary key already decides the order. Mutating it changes nothing and the
# suite passes, which is how that is known rather than assumed. It becomes
# reachable the moment two patterns can begin at the same character.
mutate overlap-contained-hit-dropped 'one realm per tenant, in prose' \
  'if any(k[0] <= start and end <= k[1] for k in kept):' \
  'if False:'

# --------------------------------------------------------------- what is read
mutate reads-tracked-files-only 'an untracked file is not read' \
  '[git, "ls-files", "-z"],' \
  '[git, "ls-files", "-z", "--others", "--cached"],'

mutate register-is-not-scanned 'a tracked register is not scanned' \
  'skip.add(str(allowlist_path.resolve().relative_to(root)))' \
  'pass'

mutate own-files-are-skipped "the check's own files are skipped by name" \
  '        "scripts/ci/prove-realm-topology-selftest-binds.sh",' \
  '        "scripts/ci/prove-realm-topology-selftest-binds.sh.not",'

# The skip list is names, not a directory. Turn it into a prefix test and the
# next file dropped beside this one could hide a real statement.
mutate skip-list-is-not-a-glob 'a neighbour in the same directory is still read' \
  'return [name for name in out.split("\0") if name and name not in skip]' \
  'return [name for name in out.split("\0") if name and not name.startswith("scripts/ci/")]'

# ------------------------------------------------------- the allowlist bindings
#
# Each of the four parts of an entry's key is mutated on its own. Dropping any
# one of them would let an exemption survive a change nobody approved.
# Each mutation makes the key blind to exactly one of its four components, by
# widening the finding set with that component overwritten. The entry then binds
# to a hit that differs from it only there — which is precisely the case that
# must refuse. Nothing else is touched, so a red run is attributable to that one
# component.
mutate binding-path 'the same entry, wrong file' \
  '    key = (path, line, rule, match)
    if key not in keys:' \
  '    key = (path, line, rule, match)
    keys = {(path, n, r, t) for (p, n, r, t) in keys} | keys
    if key not in keys:'

mutate binding-line 'the same entry, wrong line' \
  '    key = (path, line, rule, match)
    if key not in keys:' \
  '    key = (path, line, rule, match)
    keys = {(p, line, r, t) for (p, n, r, t) in keys} | keys
    if key not in keys:'

mutate binding-rule 'the same entry, wrong rule' \
  '    key = (path, line, rule, match)
    if key not in keys:' \
  '    key = (path, line, rule, match)
    keys = {(p, n, rule, t) for (p, n, r, t) in keys} | keys
    if key not in keys:'

mutate binding-match 'the same entry, wrong text' \
  '    key = (path, line, rule, match)
    if key not in keys:' \
  '    key = (path, line, rule, match)
    keys = {(p, n, r, match) for (p, n, r, t) in keys} | keys
    if key not in keys:'

mutate required-fields 'an entry that is a reason and nothing else' \
  '        if field not in entry:' \
  '        if False:'

mutate rule-vocabulary 'a rule outside the vocabulary' \
  '    if rule not in RULE_NAMES:' \
  '    if False:'

mutate reason-vocabulary 'a reason outside the vocabulary' \
  '    if reason not in REASONS:' \
  '    if False:'

mutate reason-required-extra-field 'a deferral nobody owns' \
  '        if not str(entry.get(field, "")).strip():' \
  '        if False:'

mutate line-must-be-an-integer 'a line number written as a string' \
  '    if not isinstance(line, int) or isinstance(line, bool):' \
  '    if False:'

mutate note-must-say-something 'an entry whose note is whitespace' \
  '    if not str(entry["note"]).strip():' \
  '    if False:'

mutate entry-must-name-a-tracked-file 'an entry pointed at no tracked file' \
  '    lines = lines_by_path.get(path)
    if lines is None:' \
  '    lines = lines_by_path.get(path, [])
    if False:'

mutate entry-must-be-in-range 'an entry past the end of its file' \
  'if not 1 <= line <= len(lines):' \
  'if False:'

# --------------------------------------------- the structural condition per reason
mutate condition-historical-quotation 'the same quotation outside one' \
  '    if reason == "historical-quotation" and not (
        path.startswith("docs/adr/") or in_history_section(lines, line)
    ):' \
  '    if False:'

mutate condition-deferred-contract 'deferred-contract outside contracts/' \
  '    if reason == "deferred-contract" and not path.startswith("contracts/"):' \
  '    if False:'

# A history section ends at the next heading; without that walk, "under a
# changelog" would mean "anywhere after one".
mutate history-section-walk 'a quotation inside a changelog' \
  '        if HEADING.match(line):
            return bool(HISTORY_HEADING.match(line))' \
  '        if HEADING.match(line):
            return False'

# ------------------------------------------------------------ register integrity
mutate duplicate-entries 'the same occurrence exempted twice' \
  '        if key in seen:' \
  '        if False:'

mutate allow-must-be-a-list 'a register whose allow is not a list' \
  '    if not isinstance(entries, list):' \
  '    if False:'

mutate unreadable-register-is-a-refusal 'a register that is not valid TOML' \
  '        problems.append("the allowlist could not be read")' \
  '        pass'

mutate offences-are-a-refusal 'one realm per tenant, in prose' \
  '    if offences or problems:' \
  '    if False:'

# `caught` counts what ran; `declared` reads the count back out of this file, so
# a `mutate` line that stopped being reached is a failure rather than a silence.
declared="$(grep -c '^mutate ' "${BASH_SOURCE[0]}")"
if [ "$caught" -ne "$declared" ]; then
  echo "mutation probe FAILED: $declared mutations are written here and $caught ran" >&2
  exit 1
fi
suite="$(grep -cE '^expect [01] ' "$selftest")"
owners="$(grep -oE "^mutate [a-z0-9-]+ ('[^']*'|[^ ]+)" "${BASH_SOURCE[0]}" | sed "s/^mutate [a-z0-9-]* //" | sort -u | wc -l | tr -d '[:space:]')"

echo
echo "mutation probe: $caught of $declared clauses of check-realm-topology.py removed"
echo "one at a time, each caught by the self-test case that owns it; the unmutated"
echo "suite passes. $owners of the suite's $suite cases own a clause outright."
echo "The three that do not, and why that is right:"
echo "  a tree that states the topology correctly — the baseline. It is what makes"
echo "    every refusal above attributable to its mutation rather than to the tree."
echo "  a bound entry, every field true — the same, for the register: each binding"
echo "    case is this entry with one field changed."
echo "  an entry the fix left behind — the scenario the binding exists for, an"
echo "    exemption outliving the correction it excused. It is the same clause the"
echo "    four binding-* mutations take apart component by component, so it cannot"
echo "    be mutated separately; it is kept because it is the case a reader needs"
echo "    to see, not because it proves a fifth thing."

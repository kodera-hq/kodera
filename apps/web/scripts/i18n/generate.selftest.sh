#!/usr/bin/env bash
# Proves scripts/i18n/generate.ts can actually fail (docs/dev/TESTING.md,
# "Writing a test that can actually fail"): a guard that always passes is
# worse than no guard, so this exercises each failure mode against a fixture
# before the real catalogues are ever trusted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERATE="$ROOT/scripts/i18n/generate.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

write_pair() {
  printf '%s' "$1" >"$TMP/fr.md"
  printf '%s' "$2" >"$TMP/en.md"
}

run_generate() {
  node "$GENERATE" --fr "$TMP/fr.md" --en "$TMP/en.md" --out "$TMP/out"
}

VALID_FR='| `console.common.action-continue` | Continuer |
'
VALID_EN='| `console.common.action-continue` | Continue |
'

# Control: a valid pair must succeed — otherwise the failures proven below
# could just as easily be the generator rejecting everything.
write_pair "$VALID_FR" "$VALID_EN"
if ! run_generate >"$TMP/valid.log" 2>&1; then
  cat "$TMP/valid.log" >&2
  fail "generator rejected a valid fixture — the checks below cannot be trusted"
fi
[ -f "$TMP/out/fr.json" ] || fail "generator did not write fr.json for a valid fixture"
# The same keys, one file per namespace and locale: what the browser loads.
[ -f "$TMP/out/catalogues/fr/common.json" ] || fail "generator did not write the fr common namespace"
[ -f "$TMP/out/catalogues/en/common.json" ] || fail "generator did not write the en common namespace"
grep -q '"console.common.action-continue": "Continue"' "$TMP/out/catalogues/en/common.json" ||
  fail "the en common namespace does not carry its key"

# Control for the namespace split: a second namespace gets a file of its own,
# and each key lands in the file its name says, in both locales.
TWO_FR='| `console.common.action-continue` | Continuer |
| `console.people.list.title` | Personnes |
'
TWO_EN='| `console.common.action-continue` | Continue |
| `console.people.list.title` | People |
'
write_pair "$TWO_FR" "$TWO_EN"
run_generate >"$TMP/two.log" 2>&1 || fail "generator rejected a valid two-namespace fixture"
grep -q '"console.people.list.title": "People"' "$TMP/out/catalogues/en/people.json" ||
  fail "the people key was not written to the people namespace"
if grep -q 'console.people' "$TMP/out/catalogues/en/common.json"; then
  fail "a people key was written to the common namespace"
fi

# Case 0: a namespace that lost its last key must lose its file too. A file
# left behind is a catalogue the runtime could still load, with text the
# markdown no longer has.
write_pair "$VALID_FR" "$VALID_EN"
run_generate >"$TMP/shrunk.log" 2>&1 || fail "generator rejected the valid fixture on a second run"
if [ -e "$TMP/out/catalogues/fr/people.json" ] || [ -e "$TMP/out/catalogues/en/people.json" ]; then
  fail "generator left a namespace catalogue behind after its last key was removed"
fi

# Case 1: a key in fr.md and missing from en.md must fail (parity, I18N.md rule 3).
FR_ONLY='| `console.common.action-continue` | Continuer |
| `console.common.action-cancel` | Annuler |
'
write_pair "$FR_ONLY" "$VALID_EN"
if run_generate >"$TMP/parity.log" 2>&1; then
  fail "generator accepted a key present in fr.md and missing from en.md"
fi
grep -qi 'missing from' "$TMP/parity.log" || fail "parity failure did not name the problem"

# Case 2: a duplicate key within one catalogue must fail.
DUPLICATE_FR='| `console.common.action-continue` | Continuer |
| `console.common.action-continue` | Continuer encore |
'
write_pair "$DUPLICATE_FR" "$VALID_EN"
if run_generate >"$TMP/duplicate.log" 2>&1; then
  fail "generator accepted a duplicate key"
fi
grep -qi 'duplicate' "$TMP/duplicate.log" || fail "duplicate failure did not name the problem"

# Case 3: a key that does not match console.<area>.<screen>.<key> must fail.
BAD_SHAPE_FR='| `console.notanarea` | Mauvais |
'
BAD_SHAPE_EN='| `console.notanarea` | Bad |
'
write_pair "$BAD_SHAPE_FR" "$BAD_SHAPE_EN"
if run_generate >"$TMP/shape.log" 2>&1; then
  fail "generator accepted a key with the wrong shape"
fi
grep -qi 'does not match' "$TMP/shape.log" || fail "shape failure did not name the problem"

# Case 4: a malformed table row (missing the closing pipe) must fail rather
# than being silently skipped or mis-split on a stray character.
MALFORMED_FR='| `console.common.action-continue` | Continuer
'
write_pair "$MALFORMED_FR" "$VALID_EN"
if run_generate >"$TMP/malformed.log" 2>&1; then
  fail "generator accepted a malformed table row"
fi
grep -qi 'malformed' "$TMP/malformed.log" || fail "malformed-row failure did not name the problem"

echo "OK — generate.ts accepts a valid fixture, splits it by namespace, removes a namespace that lost its keys, and rejects a parity mismatch, a duplicate key, a bad key shape, and a malformed row."

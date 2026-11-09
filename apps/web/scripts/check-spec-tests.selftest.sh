#!/usr/bin/env bash
# Proves scripts/check-spec-tests.py can actually fail (docs/dev/TESTING.md,
# "Writing a test that can actually fail"): a spec/test-name gate that always reports
# success is worse than no gate. Each case below is a deliberate mutation of a working
# fixture pair; the script exits 0 only when every mutation is caught.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-spec-tests.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

specs="$TMP/specs"
e2e="$TMP/e2e"
mkdir -p "$specs" "$e2e"

# Two fixture spec files, four acceptance-test names between them — deliberately below
# the repository's real floors, so every case below passes --min-spec-files and
# --min-names explicitly except the one case that mutates those floors themselves.
cat >"$specs/00-example.md" <<'MD'
# Example

## 12. Acceptance tests

1. **Given** a thing, **when** it happens, **then** it is visible.
   `example/one: does the first observable thing`

2. **Given** another thing, **when** it happens, **then** it is visible too.
   `example/two: does the second observable thing`

## 13. Out of scope for launch

None.
MD

cat >"$specs/01-other.md" <<'MD'
# Other

## 12. Acceptance tests

1. **Given** a thing, **when** it happens, **then** it is visible.
   `other/one: does the third observable thing`

2. **Given** another thing, **when** it happens, **then** it is visible too.
   `other/two: does the fourth observable thing`

## 13. Out of scope for launch

None.
MD

# A README alongside the specs must be ignored, the way docs/specs/README.md is: it is
# not a `<area>.md` file with its own section 12.
cat >"$specs/README.md" <<'MD'
# Specs
This file names no acceptance tests and must not be scanned as if it did.
MD

cat >"$e2e/example.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('example/one: does the first observable thing', async () => {})
test("example/two: does the second observable thing", async () => {})
TS

cat >"$e2e/other.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('other/one: does the third observable thing', async () => {})
test('other/two: does the fourth observable thing', async () => {})
TS

# The allowlist of gated specs, empty for the control and the first cases — the shape
# scripts/spec-gate.json has today.
allow="$TMP/spec-gate.json"
echo '{"requireAll": []}' >"$allow"

run_check() {
  python3 "$CHECK" --specs-dir "$specs" --e2e-dir "$e2e" --allowlist "$allow" \
    --min-spec-files 2 --min-names 4 "$@"
}

# Control: all four names exist, verbatim, in the suite. This must pass, including with
# --require-all — otherwise the failures proven below could just as easily be the
# checker rejecting everything.
if ! out="$(run_check)"; then
  echo "$out" >&2
  fail "checker rejected a fixture where every name is present"
fi
echo "$out" | grep -q 'overall: 4/4' || fail "control run did not report 4/4"
echo "$out" | grep -q 'gated: none' || fail "control run did not say no spec is gated"
if ! out="$(run_check --require-all)"; then
  echo "$out" >&2
  fail "--require-all rejected a fixture where every name is present"
fi

# Case 1: rename one test in the suite so a specified name goes missing. Without
# --require-all this must still exit 0, but name the miss; with --require-all it must
# exit 1.
sed -i.bak "s/example\/two: does the second observable thing/example\/two: does a renamed thing/" \
  "$e2e/example.spec.ts"
rm -f "$e2e/example.spec.ts.bak"

if ! out="$(run_check)"; then
  echo "$out" >&2
  fail "a missing name must not fail the run without --require-all"
fi
echo "$out" | grep -q 'missing: example/two: does the second observable thing' ||
  fail "the missing name was not reported"
echo "$out" | grep -q 'overall: 3/4' || fail "the miss did not change the overall count"

if run_check --require-all >"$TMP/require-all.log" 2>&1; then
  fail "--require-all accepted a fixture with a missing name"
fi
grep -qi 'require-all' "$TMP/require-all.log" || fail "the --require-all failure did not name the flag"

# Undo the rename before the next case.
cat >"$e2e/example.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('example/one: does the first observable thing', async () => {})
test("example/two: does the second observable thing", async () => {})
TS

# Case 1b: the allowlist. With 00-example.md listed, removing one of its named tests
# from the suite must fail the run without --require-all, naming the spec and the list;
# the same removal in the unlisted 01-other.md must still only be reported.
echo '{"requireAll": ["00-example.md"]}' >"$allow"

if ! out="$(run_check)"; then
  echo "$out" >&2
  fail "a listed spec whose names are all present must pass"
fi
echo "$out" | grep -q 'gated: 00-example.md' || fail "the listed spec was not reported as gated"

cat >"$e2e/example.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('example/one: does the first observable thing', async () => {})
TS
if run_check >"$TMP/listed.log" 2>&1; then
  fail "a listed spec with a removed test passed without --require-all"
fi
grep -q '00-example.md: 1 acceptance-test name(s) have no matching' "$TMP/listed.log" ||
  fail "the listed-spec failure did not name the spec and the count"
grep -q 'listed in spec-gate.json' "$TMP/listed.log" ||
  fail "the listed-spec failure did not say the allowlist is why"

cat >"$e2e/example.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('example/one: does the first observable thing', async () => {})
test("example/two: does the second observable thing", async () => {})
TS
cat >"$e2e/other.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('other/one: does the third observable thing', async () => {})
TS
if ! out="$(run_check)"; then
  echo "$out" >&2
  fail "a removed test in an unlisted spec must not fail the run"
fi
echo "$out" | grep -q 'missing: other/two: does the fourth observable thing' ||
  fail "the unlisted spec's miss was not reported"

cat >"$e2e/other.spec.ts" <<'TS'
import { test } from '@playwright/test'

test('other/one: does the third observable thing', async () => {})
test('other/two: does the fourth observable thing', async () => {})
TS

# Case 1c: a list that cannot gate anything must not pass — a spec file that does not
# exist (a typo would otherwise switch the gate off silently), and a list that is not
# the expected shape at all.
echo '{"requireAll": ["00-exmaple.md"]}' >"$allow"
if run_check >"$TMP/typo.log" 2>&1; then
  fail "an allowlist naming a spec that does not exist passed"
fi
grep -q 'lists 00-exmaple.md, which is not under' "$TMP/typo.log" ||
  fail "the unknown-spec failure did not name the entry"

echo '{"requireAll": "00-example.md"}' >"$allow"
if run_check >"$TMP/shape.log" 2>&1; then
  fail "a malformed allowlist passed"
fi
grep -q 'expected {"requireAll"' "$TMP/shape.log" || fail "the malformed-allowlist failure did not say the expected shape"

echo '{"requireAll": []}' >"$allow"

# Case 2: a malformed test name — a whole-line backtick in section 12 that does not
# match `<area>/<screen>: <text>` — must fail the run regardless of --require-all.
cat >"$specs/02-malformed.md" <<'MD'
# Malformed

## 12. Acceptance tests

1. **Given** a thing, **when** it happens, **then** it is visible.
   `malformed test name with no area or screen`

## 13. Out of scope for launch

None.
MD

if run_check >"$TMP/malformed.log" 2>&1; then
  fail "checker accepted a spec with a malformed acceptance-test name"
fi
grep -qi 'malformed' "$TMP/malformed.log" || fail "malformed failure did not say so"
grep -q 'malformed test name with no area or screen' "$TMP/malformed.log" ||
  fail "malformed failure did not name the offending line"

rm "$specs/02-malformed.md"

# Case 3: the vacuous-pass floor. Run the same two-file, four-name fixture against the
# repository's real defaults (5 files, 80 names) instead of the fixture-sized floor —
# it must refuse to pass.
if python3 "$CHECK" --specs-dir "$specs" --e2e-dir "$e2e" --allowlist "$allow" >"$TMP/floor.log" 2>&1; then
  fail "checker passed with only 2 spec files and 4 names against the default floor"
fi
grep -qi 'refusing to pass vacuously' "$TMP/floor.log" ||
  fail "the floor failure did not explain itself"

# Case 4: docs/specs/ absent altogether must skip loudly and exit 0.
if ! out="$(python3 "$CHECK" --specs-dir "$TMP/does-not-exist" --e2e-dir "$e2e" --allowlist "$allow")"; then
  echo "$out" >&2
  fail "a missing specs directory must exit 0"
fi
echo "$out" | grep -qi 'does not exist' || fail "the skip did not say why"

echo "OK — check-spec-tests.py accepts a fully-covered fixture and rejects a missing name under --require-all or in a spec the allowlist gates, an allowlist naming an unknown spec or of the wrong shape, a malformed name, a specs directory too thin to trust, while skipping loudly when docs/specs/ is absent."

# Source declarations, not test-shaped text in comments or strings.
cp "$e2e/example.spec.ts" "$TMP/example.original"
for shape in comment block string template; do
  printf '%s\n' "test('example/one: does the first observable thing', async () => {})" >"$e2e/example.spec.ts"
  # The template fixture is literal source, never a shell command.
  # shellcheck disable=SC2016
  case "$shape" in
    comment) printf '%s\n' '// test("example/two: does the second observable thing", async () => {})' >>"$e2e/example.spec.ts" ;;
    block) printf '%s\n' '/* test("example/two: does the second observable thing", async () => {}) */' >>"$e2e/example.spec.ts" ;;
    string) printf '%s\n' "const text = 'test(\"example/two: does the second observable thing\", async () => {})'" >>"$e2e/example.spec.ts" ;;
    template) printf '%s\n' 'const text = `test("example/two: does the second observable thing", async () => {})`' >>"$e2e/example.spec.ts" ;;
  esac
  if run_check --require-all >"$TMP/source-$shape.log" 2>&1; then
    fail "test-shaped $shape counted as a source declaration"
  fi
  grep -q 'missing: example/two:' "$TMP/source-$shape.log" || fail "$shape refusal did not identify the missing declaration"
done
cp "$TMP/example.original" "$e2e/example.spec.ts"

# Supported literal call forms include newlines and a literal template title.
cat >"$e2e/example.spec.ts" <<'TS'
test(
  'example/one: does the first observable thing',
  async () => {},
)
test(`example/two: does the second observable thing`, async () => {})
TS
run_check --require-all >"$TMP/literal-control.log" 2>&1 || fail "literal declaration control failed"
for modifier in skip fixme; do
  printf '%s\n' "test('example/one: does the first observable thing', async () => {})" >"$e2e/example.spec.ts"
  printf '%s\n' "test.$modifier('example/two: does the second observable thing', async () => {})" >>"$e2e/example.spec.ts"
  if run_check --require-all >"$TMP/inactive-$modifier.log" 2>&1; then
    fail "$modifier declaration counted as active source coverage"
  fi
  grep -q 'inactive declaration' "$TMP/inactive-$modifier.log" || fail "$modifier was not reported explicitly"
done
printf '%s\n' "test('example/one: does the first observable thing', async () => {})" 'test(computedName, async () => {})' >"$e2e/example.spec.ts"
if run_check --require-all >"$TMP/dynamic.log" 2>&1; then fail "computed title invented source coverage"; fi
grep -q 'unresolved title' "$TMP/dynamic.log" || fail "computed title was not reported"
printf '%s\n' 'test("example/one: does the first observable thing", async () => {' >"$e2e/example.spec.ts"
if run_check --require-all >"$TMP/syntax.log" 2>&1; then fail "invalid source passed"; fi
grep -q 'source scan failed' "$TMP/syntax.log" || fail "source parse failure was not identified"
cp "$TMP/example.original" "$e2e/example.spec.ts"
echo 'OK — source scanner refuses test-shaped prose, inactive declarations, unresolved titles and malformed source.'

# An enforced spec must not disappear behind another spec's global name count.
echo '{"requireAll": ["00-example.md"]}' >"$allow"
cp "$specs/00-example.md" "$TMP/spec.original"
printf '%s\n' '# Example' 'Acceptance section accidentally removed.' >"$specs/00-example.md"
if run_check --min-names 2 >"$TMP/empty-enforced.log" 2>&1; then
  fail "listed empty spec passed while another spec met the global floor"
fi
grep -q 'gated specification has no acceptance-test names' "$TMP/empty-enforced.log" || fail "empty enforced spec refusal was not identified"
cp "$TMP/spec.original" "$specs/00-example.md"
if python3 "$CHECK" --specs-dir "$TMP/absent" --allowlist "$allow" >"$TMP/absent-enforced.log" 2>&1; then
  fail "nonempty allowlist skipped an absent specification directory"
fi
grep -q 'enforced specifications directory is absent' "$TMP/absent-enforced.log" || fail "absent enforced directory refusal was not identified"
echo '{"requireAll": []}' >"$allow"
if python3 "$CHECK" --require-all --specs-dir "$TMP/absent" --allowlist "$allow" >"$TMP/absent-all.log" 2>&1; then
  fail "require-all skipped an absent specification directory"
fi
grep -q 'enforced specifications directory is absent' "$TMP/absent-all.log" || fail "absent require-all refusal was not identified"
for malformed in '{"requireAll": ["00-example.md"], "requireAll": []}' '{"requireAll": [], "unrecognized": true}'; do
  printf '%s\n' "$malformed" >"$allow"
  if run_check >"$TMP/ambiguous-list.log" 2>&1; then fail "ambiguous allowlist passed"; fi
  grep -q 'allowlist' "$TMP/ambiguous-list.log" || fail "invalid allowlist refusal was not identified"
done
if python3 "$CHECK" --specs-dir "$TMP/absent" --allowlist "$TMP/absent-list.json" >"$TMP/absent-list.log" 2>&1; then
  fail "absent allowlist was ignored with an absent specification directory"
fi
grep -q 'cannot read the allowlist' "$TMP/absent-list.log" || fail "unreadable allowlist refusal was not identified"
echo '{"requireAll": []}' >"$allow"
echo 'OK — enforcement rejects empty or absent gated specifications and ambiguous allowlists.'

# Explicit enforcement cannot turn a missing catalogue into a successful skip.
if python3 "$CHECK" --require-all --specs-dir "$TMP/does-not-exist" --e2e-dir "$e2e" >"$TMP/absent-enforced.log" 2>&1; then
  fail "require-all skipped an absent specification directory"
fi
grep -q 'enforced specifications directory is absent' "$TMP/absent-enforced.log" || fail "absent require-all refusal was not identified"
echo 'OK — require-all refuses a missing catalogue while report-only mode skips loudly.'

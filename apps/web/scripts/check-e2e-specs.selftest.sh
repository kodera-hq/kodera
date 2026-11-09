#!/usr/bin/env bash
# Prove check-e2e-specs.mjs can fail, and fail for the reason it claims.
#
# Every case asserts the MESSAGE and the exit status: expect_fail_saying checks
# rc -eq 0 first and expect_ok_saying checks rc -ne 0 first. The message because
# one bit cannot tell this check's branches apart; the status because that bit is
# the whole of what CI consumes. Exit 1 is also what a typo
# in the script produces, so a self-test reading only the status stays green
# after the check has quietly stopped checking. Three earlier drafts of that
# check reported a broken suite as an empty one; each was caught here, by the
# message rather than the code.
#
# The scratch tree is created inside the repository on purpose: the check shells
# out to `npx playwright`, and Node resolves `@playwright/test` by walking up
# from the working directory. A scratch tree in the system temp area would find
# no Playwright and every case would fail for the wrong reason.
#
# The case count at the end is computed, not written. A literal goes stale the
# first time someone deletes a case, and it goes stale silently.
set -uo pipefail

here="$(git rev-parse --show-toplevel)"
check="$here/scripts/check-e2e-specs.mjs"
work="$(mktemp -d "$here/.e2e-selftest-XXXXXX")"
fails=0
passes=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

# fixture <name> — a directory with a Playwright config pointing at ./specs
fixture() {
  local d="$work/$1"
  mkdir -p "$d/specs"
  cat > "$d/playwright.config.ts" <<'TS'
import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './specs' })
TS
  printf '%s' "$d"
}

# expect_fail_saying <dir> <substring> <command...>
expect_fail_saying() {
  local dir="$1" want="$2"; shift 2
  local out rc
  out=$(cd "$dir" && "$@" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "FAIL: expected a refusal, got exit 0"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  if ! grep -qF "$want" <<<"$out"; then
    echo "FAIL: refused, but not for the stated reason."
    echo "  wanted: $want"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  passes=$((passes+1)); echo "ok: refused saying \"$want\""
}

# expect_ok_saying <dir> <substring> <command...>
expect_ok_saying() {
  local dir="$1" want="$2"; shift 2
  local out rc
  out=$(cd "$dir" && "$@" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    echo "FAIL: expected acceptance, got exit $rc"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  if ! grep -qF "$want" <<<"$out"; then
    echo "FAIL: accepted, but did not say \"$want\""; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  passes=$((passes+1)); echo "ok: accepted saying \"$want\""
}

# --- 1: an empty suite -------------------------------------------------------
# The case the old glob guard turned into a green job.
d=$(fixture empty)
expect_fail_saying "$d" "discovered 0 runnable tests under its own testDir" node "$check"

# --- 2: a spec that cannot be parsed -----------------------------------------
# Carries a `location`. Historically the ONLY load failure this check detected.
d=$(fixture parse)
printf 'this is not typescript(((\n' > "$d/specs/broken.spec.ts"
expect_fail_saying "$d" "error(s) while loading the suite" node "$check"

# --- 3: a spec importing a module that does not exist ------------------------
# The decisive case, and the one three drafts got wrong. Playwright emits
# `Cannot find module ...` AND `No tests found`, and NEITHER carries a
# `location`. A check keyed on `location` calls this an empty suite and tells
# the reader to consider deleting the job.
d=$(fixture missingmodule)
cat > "$d/specs/needs-helper.spec.ts" <<'TS'
import { test } from '@playwright/test'
import { useScenario } from './support/useScenario'
test('needs a helper that is gone', async () => { useScenario() })
TS
expect_fail_saying "$d" "error(s) while loading the suite" node "$check"
out=$(cd "$d" && node "$check" 2>&1)
if grep -qF "Cannot find module" <<<"$out"; then
  passes=$((passes+1)); echo "ok: the load error itself is printed, not discarded"
else
  echo "FAIL: refused without printing the diagnostic that names the cause"; fails=$((fails+1))
fi

# --- 3b: a thrown error whose message merely CONTAINS the phrase -------------
# Draft 4 of this check's oldest defect. A module-scope throw carrying
# "No tests found for ..." matched a loose substring test and the suite was
# reported as empty, with a suggestion to delete the job. Playwright's own
# empty-suite error is exactly that sentence AND carries no location; a thrown
# one carries both a longer message and a location.
d=$(fixture phrasethrow)
mkdir -p "$d/specs/support"
cat > "$d/specs/support/overlays.ts" <<'TS'
throw new Error('No tests found for the overlays directory; regenerate the scenario overlays first')
TS
cat > "$d/specs/uses-overlays.spec.ts" <<'TS'
import { test } from '@playwright/test'
import './support/overlays'
test('needs the overlays', async () => {})
TS
expect_fail_saying "$d" "error(s) while loading the suite" node "$check"

# --- 3f: a spec throwing EXACTLY the phrase ----------------------------------
# Pins the `!e?.location` half of isEmptySuiteError. Playwright emits two errors
# here: the thrown one WITH a location, and its own empty-suite error without.
# Drop the location clause and this is reported as an empty suite, "with a
# suggestion to delete the job" — the exact failure this check exists to prevent.
# 3b does not pin it: its thrown error carries a longer message, so the anchor
# separates it and the location clause is never the thing that decides.
d=$(fixture exactthrow)
cat > "$d/specs/boom.spec.ts" <<'TS'
import { test } from '@playwright/test'
throw new Error('No tests found')
test('never reached', async () => {})
TS
expect_fail_saying "$d" "error(s) while loading the suite" node "$check"

# --- 3g: a no-location error that merely CONTAINS the phrase -----------------
# Pins the anchor. Here NEITHER error carries a location, so the location clause
# cannot help and only the anchored regex separates a broken suite from an empty
# one. Loosen the anchor to a substring and this too is called empty.
#
# 3f and 3g are deliberately separate: each breaks ONE half of the conjunction.
# Broken together they were caught, which is what made both halves look proven
# when neither was.
d=$(fixture phrasenoloc)
mkdir -p "$d/node_modules/phrasepkg"
printf '{"name":"phrasepkg","version":"1.0.0","main":"index.js"}\n' > "$d/node_modules/phrasepkg/package.json"
printf "throw new Error('No tests found in phrasepkg registry')\n" > "$d/node_modules/phrasepkg/index.js"
cat > "$d/specs/c.spec.ts" <<'TS'
import { test } from '@playwright/test'
import 'phrasepkg'
test('c', async () => {})
TS
expect_fail_saying "$d" "error(s) while loading the suite" node "$check"

# --- 3c: the raw listing is printed, not only the refusal message ------------
# Case 3's grep could not see this: the refusal message interpolates each load
# error's FIRST line, so a check that discards the captured output entirely
# still satisfies it. This asserts on something only the raw listing carries --
# the source snippet Playwright prints beneath a parse error.
d=$(fixture detail)
printf 'this is not typescript(((\n' > "$d/specs/broken.spec.ts"
# Strip ANSI before matching. Playwright colourises the offending source line
# when it believes it is on a CI terminal, so the snippet reaches us as
# `ESC[36mthis ESC[39m is not typescript(((` and the contiguous needle below
# never appears -- this case passed on a developer machine and failed in CI for
# that reason alone, which is a defect in the assertion and not in the check.
# The claim being tested is that the listing's CONTENT is printed, so the
# colour codes are noise and are removed rather than matched around.
out=$(cd "$d" && node "$check" 2>&1 | sed $'s/\033\[[0-9;]*m//g')
if grep -qF 'is not typescript(((' <<<"$out"; then
  passes=$((passes+1)); echo "ok: the raw listing is printed, not just the refusal message"
else
  echo "FAIL: refused without printing the captured listing"
  printf '%s\n' "$out" | sed 's/^/    /'; fails=$((fails+1))
fi

# --- 3d: a listing that is a JSON array --------------------------------------
# Valid JSON, not a report. Without its own arm this reaches the count branch
# and reports an empty suite -- again suggesting the job be deleted.
d=$(fixture jsonarray)
mkdir -p "$d/bin"
printf '#!/usr/bin/env bash\necho "[]"\nexit 0\n' > "$d/bin/npx"
chmod +x "$d/bin/npx"
expect_fail_saying "$d" "not a report object" env "PATH=$d/bin:$PATH" node "$check"

# --- 3e: tests nested inside a describe block --------------------------------
# The count recurses into child suites. This repository writes every spec at
# file top level, so the real suite cannot exercise that recursion: drop it and
# the 95-test suite still counts 95, while a nested fixture silently counts 0.
d=$(fixture nested)
cat > "$d/specs/nested.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'
test.describe('a group', () => {
  test('one', async () => { expect(1).toBe(1) })
  test('two', async () => { expect(1).toBe(1) })
})
TS
expect_ok_saying "$d" "discovered 2 runnable tests" node "$check"

# --- 4: every test skipped ---------------------------------------------------
# Playwright lists them, so a naive count is nonzero while the run executes
# nothing. Same outcome as an empty suite, by another route.
d=$(fixture allskipped)
cat > "$d/specs/skipped.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'
test.describe.skip('all of it', () => {
  test('one', async () => { expect(1).toBe(1) })
  test('two', async () => { expect(1).toBe(1) })
})
TS
expect_fail_saying "$d" "discovered 0 runnable tests under its own testDir" node "$check"

# --- 5a: skipped tests are excluded from the count, executed ones are not ----
# Pins the skip filter in both directions at once. An all-skipped fixture cannot
# do that: it stays red whether the filter counts skips or the file is simply
# empty, so it proves the refusal without proving the count.
d=$(fixture mixed)
cat > "$d/specs/mixed.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'
test.fixme('a fixme test', async () => { expect(1).toBe(1) })
test.skip('a skipped test', async () => { expect(1).toBe(1) })
test('a real test', async () => { expect(1).toBe(1) })
TS
expect_ok_saying "$d" "discovered 1 runnable tests" node "$check"

# --- 5: the count is the number of tests, and is asserted --------------------
# Without this, replacing the count with something else -- the number of
# suites, say -- reports a wrong number and every other case still passes.
d=$(fixture counted)
cat > "$d/specs/two.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'
test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(1).toBe(1) })
TS
cat > "$d/specs/one.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'
test('c', async () => { expect(1).toBe(1) })
TS
expect_ok_saying "$d" "discovered 3 runnable tests" node "$check"

# --- 6: a listing that is not JSON -------------------------------------------
# A stubbed `npx` makes the case deterministic instead of waiting for an
# upstream format change to produce it by accident.
d=$(fixture notjson)
mkdir -p "$d/bin"
cat > "$d/bin/npx" <<'STUB'
#!/usr/bin/env bash
echo "Listing tests:"
echo "  [chromium] > somewhere.spec.ts:1:1 > a test"
exit 0
STUB
chmod +x "$d/bin/npx"
expect_fail_saying "$d" "no readable JSON listing" env "PATH=$d/bin:$PATH" node "$check"

# --- 7: a listing that is valid JSON but not a report ------------------------
# `null` parses. Without this branch the check dereferences it and dies with a
# raw stack carrying no `check-e2e-specs:` line at all.
d=$(fixture jsonnull)
mkdir -p "$d/bin"
printf '#!/usr/bin/env bash\necho null\nexit 0\n' > "$d/bin/npx"
chmod +x "$d/bin/npx"
expect_fail_saying "$d" "not a report object" env "PATH=$d/bin:$PATH" node "$check"

# --- 8: tests listed, but the lister exited non-zero -------------------------
# A partial listing must not be reported as a suite this job ran.
d=$(fixture dirtyexit)
mkdir -p "$d/bin"
cat > "$d/bin/npx" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"errors":[],"suites":[{"specs":[{"title":"a","tests":[{"expectedStatus":"passed","annotations":[]}]}],"suites":[]}]}
JSON
exit 3
STUB
chmod +x "$d/bin/npx"
expect_fail_saying "$d" "but exited 3" env "PATH=$d/bin:$PATH" node "$check"

# --- 9: Playwright cannot be run at all --------------------------------------
# A PATH carrying `node` but no `npx` is the deterministic stand-in for a broken
# toolchain. Without this branch the failure surfaces as an unhandled null
# dereference with no `check-e2e-specs:` line at all.
#
# `node` has to stay reachable or the case fails because the *test harness*
# could not start, which is a different thing and would pass for the wrong
# reason -- an emptied PATH does exactly that.
d=$(fixture nonpx)
mkdir -p "$d/onlynode"
ln -s "$(command -v node)" "$d/onlynode/node"
expect_fail_saying "$d" "could not run Playwright at all" env "PATH=$d/onlynode" node "$check"

# --- 10: the real suite is still accepted ------------------------------------
# A check that refuses everything is not a check.
if out=$(cd "$here" && node "$check" 2>&1); then
  if grep -q "runnable tests. Running them." <<<"$out"; then
    passes=$((passes+1)); echo "ok: the real suite is accepted -- $out"
  else
    echo "FAIL: real suite accepted, but without reporting a count"; fails=$((fails+1))
  fi
else
  echo "FAIL: the real suite was refused"; printf '%s\n' "$out" | sed 's/^/    /'; fails=$((fails+1))
fi

if [ $fails -ne 0 ]; then
  echo "check-e2e-specs.selftest: $fails case(s) failed"
  exit 1
fi
echo "check-e2e-specs.selftest: $passes cases OK"

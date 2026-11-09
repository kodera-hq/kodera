#!/usr/bin/env bash
# Prove check-uv-lock.sh can fail, and fail for the reason it says.
#
# Each case asserts the MESSAGE as well as a non-zero exit. The message because
# exit 1 is also what a missing `uv` or a typo in the script produces, so a
# self-test reading only the status stays green after the check has quietly
# stopped checking; the status because that one bit is the whole of what CI
# consumes.
#
# The cases work on copies of this repository's own pyproject.toml, uv.lock and
# Dockerfile, so the mutations follow the real files through every Dependabot
# bump instead of freezing a fixture that drifts from them.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="$here/scripts/ci/check-uv-lock.sh"
work="$(mktemp -d)"
fails=0
oks=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

ok() { echo "ok: $1"; oks=$((oks+1)); }

# copy <name> — a project directory holding this repository's three files
copy() {
  local d="$work/$1"
  mkdir -p "$d"
  cp "$here/pyproject.toml" "$here/uv.lock" "$here/Dockerfile" "$d/"
  printf '%s' "$d"
}

# expect_fail_saying <substring> <check-arguments...>
expect_fail_saying() {
  local want="$1"; shift
  local out rc
  out=$(bash "$check" "$@" 2>&1); rc=$?
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
  ok "refused saying \"$want\""
}

# Both refusals must carry uv's own verdict, not only this script's line: the
# script prints its line on ANY failure of `uv lock`, including one that has
# nothing to do with a stale lock.
stale="The lockfile at \`uv.lock\` needs to be updated"

# --- case 1: the files as committed pass -------------------------------------
# Without this, every refusal below could come from a copy that was broken
# before it was mutated, and the self-test would prove nothing.
d=$(copy clean)
out=$(bash "$check" "$d" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -qF "uv.lock matches pyproject.toml." <<<"$out"; then
  ok "the committed pair is accepted"
else
  echo "FAIL: the committed pyproject.toml and uv.lock are refused (exit $rc)"
  printf '%s\n' "$out" | sed 's/^/    /'
  fails=$((fails+1))
fi

# --- case 2: pyproject.toml changes a pin, uv.lock does not ----------------
# The defect itself (#113): the manifest moved, the lock was not regenerated.
# The lock stays the valid one generated before, as a forgotten `uv lock`
# leaves it. Loosen the first runtime pin from `==` to `>=`: the version the
# lock resolved still satisfies it, so only the record of the requirement is
# stale, and no new release has to exist for the mutation to hold.
d=$(copy stale-lock)
python3 -c 'import pathlib, re, sys; p = pathlib.Path(sys.argv[1]); p.write_text(re.sub(r"(?m)^(  \"[^\"=]+)==", r"\1>=", p.read_text(), count=1))' "$d/pyproject.toml"
if cmp -s "$here/pyproject.toml" "$d/pyproject.toml"; then
  echo "FAIL: case 2 found no exact runtime pin to loosen; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "$stale" "$d"
fi

# --- case 3: pyproject.toml loses a dependency the lock still records --------
# The same disagreement from the other side: the manifest moved, the lock did
# not. Drop the first runtime dependency line.
d=$(copy stale-manifest)
python3 -c 'import pathlib, re, sys; p = pathlib.Path(sys.argv[1]); p.write_text(re.sub(r"(?m)^  \"[^\n]+\n", "", p.read_text(), count=1))' "$d/pyproject.toml"
if cmp -s "$here/pyproject.toml" "$d/pyproject.toml"; then
  echo "FAIL: case 3 found no runtime dependency to drop; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "$stale" "$d"
fi

# --- case 4: this script's own line accompanies the refusal ------------------
# The line a reader acts on. Asserted on the case 2 copy, already mutated.
expect_fail_saying "uv.lock does not match pyproject.toml" "$work/stale-lock"

# --- case 5: the check runs with the uv the Dockerfile pins ------------------
# CI installs the latest uv, the image uses the pinned one, and an older uv can
# refuse a lock a newer one wrote. The version is read here independently of
# the script, and compared with the release the script reports having run.
pin=$(sed -nE 's|^FROM ghcr\.io/astral-sh/uv:([0-9]+\.[0-9]+\.[0-9]+)[@ ].*|\1|p' "$here/Dockerfile")
out=$(bash "$check" "$work/clean" 2>/dev/null)
if [ -n "$pin" ] && grep -qE "^checking with uv $pin " <<<"$out"; then
  ok "the check ran with uv $pin, the Dockerfile's pin"
else
  echo "FAIL: the check did not report running uv '${pin}' from the Dockerfile"
  printf '%s\n' "$out" | sed 's/^/    /'
  fails=$((fails+1))
fi

# --- case 6: the Dockerfile no longer pins uv --------------------------------
# Without a pin there is no release to check with. Falling back to whatever uv
# is installed would quietly reopen the gap case 5 closes.
d=$(copy no-pin)
python3 -c 'import pathlib, re, sys; p = pathlib.Path(sys.argv[1]); p.write_text(re.sub(r"(?m)^FROM ghcr\.io/astral-sh/uv:[^\n]+\n", "", p.read_text()))' "$d/Dockerfile"
expect_fail_saying "cannot find exactly one uv version pinned in" "$d"

# --- case 7: an option is not a project directory ----------------------------
# `--help` once reached `uv lock --project` and was reported as a stale lock.
expect_fail_saying "usage: check-uv-lock.sh [project-dir]" --help

echo "---"
echo "$oks ok, $fails failed"
[ "$fails" -eq 0 ]

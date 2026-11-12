#!/usr/bin/env bash
# Prove check-contract-parity.sh can fail, and fail for the reason it says.
#
# Each case asserts the MESSAGE as well as the exit status: exit 1 is also what
# a typo in the script produces, and a self-test reading only the status stays
# green after the check has stopped comparing. The cases work on copies of
# this repository's own six contract files, so they follow the real documents
# through every version instead of freezing a fixture that drifts from them.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
check="$here/check-contract-parity.sh"
work="$(mktemp -d)"
fails=0
oks=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

ok() { echo "ok: $1"; oks=$((oks + 1)); }
fail() { echo "FAIL: $1"; shift; printf '%s\n' "$@" | sed 's/^/    /'; fails=$((fails + 1)); }

directories=("packages/api-contract" "apps/server/contracts" "apps/web/contracts")
contracts=("core-api.openapi.yaml" "agent-api.openapi.yaml")

# tree <name> — a repository root holding this checkout's six contract files
tree() {
  local root="$work/$1" directory name
  for directory in "${directories[@]}"; do
    mkdir -p "$root/$directory"
    for name in "${contracts[@]}"; do
      cp "$repo/$directory/$name" "$root/$directory/$name"
    done
  done
  printf '%s' "$root"
}

# expect_refusal <case> <tree> <wanted line> [<line that must not appear>]
expect_refusal() {
  local name="$1" root="$2" want="$3" unwanted="${4:-}" out rc
  out=$(bash "$check" "$root" 2>&1); rc=$?
  if [ $rc -ne 1 ]; then
    fail "$name: expected exit 1, got $rc" "$out"; return
  fi
  if ! grep -qxF "$want" <<<"$out"; then
    fail "$name: refused, but not for the stated reason (wanted: $want)" "$out"; return
  fi
  if [ -n "$unwanted" ] && grep -qF "$unwanted" <<<"$out"; then
    fail "$name: also blamed a copy that was not touched ($unwanted)" "$out"; return
  fi
  ok "$name: refused saying \"$want\""
}

# --- the committed copies pass -------------------------------------------------
# Without this, every refusal below could come from a tree that was already
# drifted before it was mutated, and the self-test would prove nothing.
out=$(bash "$check" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -qxF "contract parity passed: 4 copies byte-identical to packages/api-contract/" <<<"$out"; then
  ok "the committed copies are accepted"
else
  fail "the committed copies are refused (exit $rc)" "$out"
fi

clean=$(tree clean)
out=$(bash "$check" "$clean" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -qF "contract parity passed: 4 copies" <<<"$out"; then
  ok "an unmutated tree is accepted"
else
  fail "an unmutated tree is refused (exit $rc)" "$out"
fi

# --- one byte appended to one copy, each copy in turn ----------------------------
for copy in "apps/server/contracts" "apps/web/contracts"; do
  for name in "${contracts[@]}"; do
    root=$(tree "drift-$(basename "$(dirname "$copy")")-$name")
    printf '\n' >> "$root/$copy/$name"
    other="apps/web/contracts"; [ "$copy" = "$other" ] && other="apps/server/contracts"
    expect_refusal "one byte appended to $copy/$name" "$root" \
      "PARITY: $copy/$name differs from packages/api-contract/$name" \
      "PARITY: $other/"
  done
done

# --- one byte changed in place: same size, same line count ------------------------
root=$(tree in-place)
python3 - "$root/apps/web/contracts/core-api.openapi.yaml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
index = data.index(b"crisis-cell")
data[index] ^= 0x20  # `c` becomes `C`: the file keeps its length
path.write_bytes(bytes(data))
PY
expect_refusal "one byte changed in place in the console's copy" "$root" \
  "PARITY: apps/web/contracts/core-api.openapi.yaml differs from packages/api-contract/core-api.openapi.yaml"

# --- the canonical file edited alone: both copies are named ------------------------
root=$(tree canonical-edited)
printf '\n' >> "$root/packages/api-contract/core-api.openapi.yaml"
expect_refusal "the canonical contract edited alone (server copy)" "$root" \
  "PARITY: apps/server/contracts/core-api.openapi.yaml differs from packages/api-contract/core-api.openapi.yaml"
expect_refusal "the canonical contract edited alone (console copy)" "$root" \
  "PARITY: apps/web/contracts/core-api.openapi.yaml differs from packages/api-contract/core-api.openapi.yaml"

# --- a missing file is a failure, never a skipped comparison -----------------------
root=$(tree copy-missing)
rm "$root/apps/server/contracts/agent-api.openapi.yaml"
expect_refusal "a missing copy" "$root" "PARITY: apps/server/contracts/agent-api.openapi.yaml is missing"

root=$(tree canonical-missing)
rm "$root/packages/api-contract/core-api.openapi.yaml"
expect_refusal "a missing canonical contract" "$root" "PARITY: packages/api-contract/core-api.openapi.yaml is missing"

# --- a wrong invocation is not a verdict -------------------------------------------
out=$(bash "$check" --help 2>&1); rc=$?
if [ $rc -eq 2 ] && grep -qF "usage: check-contract-parity.sh" <<<"$out"; then
  ok "an option is refused with the usage line and exit 2"
else
  fail "an option was not refused with exit 2 (exit $rc)" "$out"
fi

if [ "$fails" -ne 0 ]; then
  echo "contract parity self-test FAILED: $fails case(s)"
  exit 1
fi
echo "contract parity self-test passed: $oks case(s)"

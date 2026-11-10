#!/usr/bin/env bash
# Prove check-image-dependencies.sh can fail, and fail for the reason it says.
#
# Each case asserts the MESSAGE as well as a non-zero exit. The message because
# exit 1 is also what a missing `docker`, an unreachable registry or a typo in
# the script produces, so a self-test reading only the status stays green after
# the check has quietly stopped checking; the status because that one bit is
# the whole of what CI consumes.
#
# The cases build copies of this repository's own Dockerfile, pyproject.toml
# and uv.lock, so the mutations follow the real files through every Dependabot
# bump instead of freezing a fixture that drifts from them.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="$here/scripts/ci/check-image-dependencies.sh"
work="$(mktemp -d)" || { echo "FAIL: cannot create a work directory"; exit 1; }
fails=0
oks=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

ok() { echo "ok: $1"; oks=$((oks+1)); }

# copy <name> — sets d to a build context holding this repository's three
# files. Not called in a subshell, so a failed setup stops the self-test here
# instead of every case below refusing an empty directory for the wrong reason.
copy() {
  d="$work/$1"
  if ! { mkdir -p "$d" && cp "$here/Dockerfile" "$here/pyproject.toml" "$here/uv.lock" "$d/"; }; then
    echo "FAIL: cannot prepare $d"; exit 1
  fi
}

# Keep mutation edits portable across Linux and macOS.
mutate() {
  python3 - "$@" <<'PYTHON'
import re
import sys
from pathlib import Path
path, pattern, replacement = sys.argv[1:]
file = Path(path)
changed, count = re.subn(pattern, replacement, file.read_text(), count=1, flags=re.MULTILINE)
if count != 1:
    sys.exit(f"mutation matched {count} sites: {pattern}")
file.write_text(changed)
PYTHON
}

# judge <substring> <exit status> <output> — a refusal, for the stated reason
judge() {
  local want="$1" rc="$2" out="$3"
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: expected a refusal, got exit 0"; printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  if ! grep -qF "$want" <<<"$out"; then
    echo "FAIL: refused, but not for the stated reason."
    echo "  wanted: $want"
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /'
    fails=$((fails+1)); return
  fi
  ok "refused saying \"$want\""
}

# expect_fail_saying <substring> <check-arguments...>
expect_fail_saying() {
  local want="$1"; shift
  local out rc
  out=$(bash "$check" "$@" 2>&1); rc=$?
  judge "$want" "$rc" "$out"
}

pin=$(sed -nE 's|^FROM ghcr\.io/astral-sh/uv:([0-9]+\.[0-9]+\.[0-9]+)[@ ].*|\1|p' "$here/Dockerfile")

# --- case 1: the files as committed build ------------------------------------
# Without this, every refusal below could come from a context that was broken
# before it was mutated, and the self-test would prove nothing.
copy clean
out=$(bash "$check" "$d" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -qF "the image's dependencies stage builds with uv $pin " <<<"$out"; then
  ok "the committed files build, with uv $pin"
else
  echo "FAIL: the committed Dockerfile, pyproject.toml and uv.lock do not build (exit $rc)"
  printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /'
  fails=$((fails+1))
fi

# --- case 2: pyproject.toml changes a pin, uv.lock does not ----------------
# A lock the image's `uv sync --locked` refuses. Loosen the first runtime pin
# from `==` to `>=`: the version the lock resolved still satisfies it, so only
# the record of the requirement is stale, and no new release has to exist for
# the mutation to hold. The assertion is uv's own sentence, which only the
# `RUN uv sync` step inside the build can print.
copy stale-lock
mutate "$d/pyproject.toml" '(?s)(^dependencies = \[.*?^  "[^"=]*?)==' '\g<1>>='
if cmp -s "$here/pyproject.toml" "$d/pyproject.toml"; then
  echo "FAIL: case 2 found no exact runtime pin to loosen; the mutation did nothing"
  fails=$((fails+1))
else
  # One build, two assertions: a failed RUN step is not cached, so a second
  # call would build the stage again.
  out=$(bash "$check" "$d" 2>&1); rc=$?
  judge "The lockfile at \`uv.lock\` needs to be updated, but \`--locked\` was provided." "$rc" "$out"
  # The line a reader acts on accompanies uv's.
  judge "the image's dependencies stage does not build" "$rc" "$out"
fi

# --- case 3: the tag says one uv, the digest selects another ----------------
# Docker ignores the tag when a digest is present, so this context still
# builds with the uv the digest selects. Only the version check refuses it.
copy tag-mismatch
mutate "$d/Dockerfile" '^(FROM ghcr\.io/astral-sh/uv:)[0-9.]+@' '\g<1>0.0.1@'
if cmp -s "$here/Dockerfile" "$d/Dockerfile"; then
  echo "FAIL: case 3 found no uv tag to change; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "the Dockerfile tags uv 0.0.1, but the dependencies stage runs uv $pin " "$d"
fi

# --- case 4: the uv stage loses its digest -----------------------------------
# A tag alone has nothing to compare with, and Docker would follow it wherever
# it moves. The version check would agree with itself and pass.
copy no-digest
mutate "$d/Dockerfile" '^(FROM ghcr\.io/astral-sh/uv:[0-9.]+)@sha256:[0-9a-f]{64}' '\1'
if cmp -s "$here/Dockerfile" "$d/Dockerfile"; then
  echo "FAIL: case 4 found no uv digest to drop; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "cannot find exactly one digest-pinned uv stage in" "$d"
fi

# --- case 5: the pinned reference is not the stage that is built -----------
# The pinned line renamed away from `uv`, and a stage named `uv` added from
# another image. Reading the first line would compare its tag with the other
# stage's binary.
copy other-stage
mutate "$d/Dockerfile" '^(FROM ghcr\.io/astral-sh/uv:.*) AS uv$' '\1 AS uv-source\nFROM python:3.12-slim-bookworm AS uv'
if cmp -s "$here/Dockerfile" "$d/Dockerfile"; then
  echo "FAIL: case 5 found no uv stage to rename; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "cannot find exactly one digest-pinned uv stage in" "$d"
fi

# --- case 6: the dependencies stage takes uv from somewhere else ------------
# The pinned `uv` stage stays as it is, and the dependencies stage gets its
# `uv` another way: a stand-in that prints a version and accepts any command,
# so the build itself succeeds. Only reading the version from the BUILT stage,
# not from the `uv` stage, refuses it. No other image is pulled.
copy uv-from-elsewhere
mutate "$d/Dockerfile" '^COPY --from=uv /uv (/usr/local/bin/uv)$' 'RUN printf "#!/bin/sh\\necho \"uv 0.0.1 (stand-in)\"\\n" > \1 && chmod +x \1'
if cmp -s "$here/Dockerfile" "$d/Dockerfile"; then
  echo "FAIL: case 6 found no \`COPY --from=uv\` to replace; the mutation did nothing"
  fails=$((fails+1))
else
  expect_fail_saying "the Dockerfile tags uv $pin, but the dependencies stage runs uv 0.0.1 (stand-in)" "$d"
fi

# --- case 7: the Dockerfile no longer pins uv --------------------------------
copy no-pin
mutate "$d/Dockerfile" '^FROM ghcr\.io/astral-sh/uv:.*\n' ''
expect_fail_saying "cannot find exactly one digest-pinned uv stage in" "$d"

# --- case 8: an option is not a build context --------------------------------
expect_fail_saying "usage: check-image-dependencies.sh [context-dir]" --help

echo "---"
echo "$oks ok, $fails failed"
[ "$fails" -eq 0 ]

#!/usr/bin/env bash
# Proves the index check can fail.
#
# The cases that matter are the orphan and the phantom: a document nobody
# indexed and a row that names a file which is not there. Both were true of
# main before this check existed, so a version of it that cannot see either is
# the prose promise it replaces. The reserved-row cases pin the one exception
# the index states for itself in both directions.

# The fixtures are Markdown, and Markdown quotes a path in backticks; nothing
# in them is meant to expand.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-docs-index.py"

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/docs-index-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# fixture <name> <index body>: a repository root with docs/INDEX.md.
fixture() {
  mkdir -p "$work/$1/docs"
  printf '%s\n' "$2" > "$work/$1/docs/INDEX.md"
}

# plant <name> <path relative to the fixture root>
plant() {
  mkdir -p "$(dirname "$work/$1/$2")"
  printf 'x\n' > "$work/$1/$2"
}

expect() {
  local want="$1" label="$2" got=0
  python3 "$script" --root "$work/$2" >/dev/null 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$label' expected exit $want, got $got" >&2
    python3 "$script" --root "$work/$2" >&2 || true
    exit 1
  fi
  printf '  ok  %-40s exit %s\n' "$label" "$got"
}

echo "check-docs-index self-test"

# A linked row, a bare-backtick row, a row outside docs/, a directory row, a
# nested document, and a table the check must ignore.
complete='# Index

| Seat | Scope |
|---|---|
| Product seat | Not a document row |

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`INDEX.md`](INDEX.md) | Proposed | Product seat | This file |
| [`a.md`](a.md) | Proposed | API seat | Linked row |
| `sub/b.md` | Proposed | API seat | Bare row |

| File | Status | Owner | Purpose |
|---|---|---|---|
| `../OUTSIDE.md` | Accepted | API seat | Outside docs/ |
| `../.github/` | Proposed | API seat | A directory |'
fixture complete "$complete"
plant complete docs/a.md
plant complete docs/sub/b.md
plant complete OUTSIDE.md
plant complete .github/keep
expect 0 complete

fixture orphan "$complete"
plant orphan docs/a.md
plant orphan docs/sub/b.md
plant orphan OUTSIDE.md
plant orphan .github/keep
plant orphan docs/c.md
expect 1 orphan

fixture nested-orphan "$complete"
plant nested-orphan docs/a.md
plant nested-orphan docs/sub/b.md
plant nested-orphan OUTSIDE.md
plant nested-orphan .github/keep
plant nested-orphan docs/sub/deeper/d.md
expect 1 nested-orphan

# The row is there; the file is not.
fixture phantom "$complete"
plant phantom docs/a.md
plant phantom OUTSIDE.md
plant phantom .github/keep
expect 1 phantom

fixture phantom-outside "$complete"
plant phantom-outside docs/a.md
plant phantom-outside docs/sub/b.md
plant phantom-outside .github/keep
expect 1 phantom-outside

# A dotfile is not a document, so it needs no row.
fixture dotfile "$complete"
plant dotfile docs/a.md
plant dotfile docs/sub/b.md
plant dotfile OUTSIDE.md
plant dotfile .github/keep
plant dotfile docs/.keep
expect 0 dotfile

reserved='# Index

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`INDEX.md`](INDEX.md) | Proposed | Product seat | This file |
| `future.md` | Proposed | API seat | Owed by another workstream. *Written in parallel* |'
fixture reserved-phantom "$reserved"
expect 0 reserved-phantom

# The workstream merged and nobody dropped the annotation.
fixture stale-reservation "$reserved"
plant stale-reservation docs/future.md
expect 1 stale-reservation

# A row with no path in a document table is a row the check cannot read.
# Guessing is how an unindexed document gets reported as indexed.
fixture unreadable '# Index

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`INDEX.md`](INDEX.md) | Proposed | Product seat | This file |
| some prose | Proposed | API seat | No path here |'
expect 1 unreadable

# The index must list itself, or the orphan rule does not hold on the file
# that states it.
fixture self-orphan '# Index

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`a.md`](a.md) | Proposed | API seat | Only row |'
plant self-orphan docs/a.md
expect 1 self-orphan

mkdir -p "$work/no-index/docs"
expect 1 no-index

echo "self-test passed: an orphan, a nested orphan, a phantom inside and outside"
echo "docs/, a stale reservation, an unreadable row, a self-orphan and a missing"
echo "index are all caught, and a reserved row may still name a future file"

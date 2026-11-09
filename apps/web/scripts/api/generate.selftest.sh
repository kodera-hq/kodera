#!/usr/bin/env bash
# Proves the generator's two refusals can actually fire, and that its one composition
# rule produces what the mocks need.
#
# A generator that silently emitted an empty page, or accepted a contract whose sha256
# does not match the lock, would produce a green suite measured against nothing. Each
# case below is a deliberate mutation of a working input; this script exits 0 only when
# every mutation is caught.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
fixtures="$here/fixtures"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "generate.selftest: $1" >&2
  exit 1
}

lock_for() {
  # $1 spec path, $2 destination, $3 sha256 override (optional)
  local sha
  sha="${3:-$(shasum -a 256 "$1" | cut -d' ' -f1)}"
  cat >"$2" <<EOF
{
  "repository": "fixture",
  "ref": "fixture",
  "path": "$(basename "$1")",
  "version": "1.0.0",
  "sha256": "$sha"
}
EOF
}

run() {
  # $1 spec, $2 lock, $3 out dir. Echoes the exit code, never aborts the script.
  set +e
  node "$root/scripts/api/generate.ts" --contract "$1" --lock "$2" --out "$3" >"$tmp/stdout" 2>"$tmp/stderr"
  local code=$?
  set -e
  echo "$code"
}

# 1. A complete contract generates, and the collection example is NOT the empty page the
#    CursorPage envelope carries. This is the assertion the whole mock layer rests on.
lock_for "$fixtures/complete.openapi.yaml" "$tmp/complete.lock.json"
code="$(run "$fixtures/complete.openapi.yaml" "$tmp/complete.lock.json" "$tmp/good")"
[ "$code" = "0" ] || fail "a complete contract should generate, exited $code: $(cat "$tmp/stderr")"

examples="$tmp/good/src/mocks/generated/examples.ts"
[ -f "$examples" ] || fail "no examples.ts was written"
grep -q '"id": "w-1"' "$examples" || fail "the list example is empty; CursorPage was not composed with its item"
grep -q 'isList: true' "$examples" || fail "the collection was not recognised as a CursorPage"
grep -q 'GENERATED FILE' "$examples" || fail "the generated file carries no do-not-edit header"
grep -q 'answerIdempotent' "$tmp/good/src/mocks/generated/handlers.ts" ||
  fail "the POST handler does not replay by idempotency key"
# `rebuildWidget`'s `Location` example sits on the header object itself (`example:`),
# not on its schema — the shape every `Location` header in the real contract uses. A
# reader that only checks `schema.examples` finds this one empty and drops the header;
# this is the mutation that catches "the generator ignores header.example" regressing.
grep -q '"Location": "/jobs/job-1"' "$examples" ||
  fail "the header-level Location example (schema carries none) was dropped"

# 2. Mutation: a schema with no example. The contract's examples ARE the mocks, so the
#    generator must name the schema and stop rather than invent a value for it.
lock_for "$fixtures/no-example.openapi.yaml" "$tmp/no-example.lock.json"
code="$(run "$fixtures/no-example.openapi.yaml" "$tmp/no-example.lock.json" "$tmp/missing")"
[ "$code" = "1" ] || fail "a schema with no example should exit 1, exited $code"
grep -q 'no example' "$tmp/stderr" || fail "the failure does not say what is missing"
grep -q 'Widget' "$tmp/stderr" || fail "the failure does not name the schema"

# 3. Mutation: the lock does not match the file. An edited local copy of the contract is
#    the one failure the pin exists to catch.
lock_for "$fixtures/complete.openapi.yaml" "$tmp/wrong.lock.json" \
  "0000000000000000000000000000000000000000000000000000000000000000"
code="$(run "$fixtures/complete.openapi.yaml" "$tmp/wrong.lock.json" "$tmp/drift")"
[ "$code" = "1" ] || fail "a sha256 mismatch should exit 1, exited $code"
grep -q 'sha256' "$tmp/stderr" || fail "the failure does not mention the hash"

echo "generate.selftest: 3 cases, the two mutations were both caught."

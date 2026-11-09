#!/usr/bin/env bash
# Proves scripts/i18n/check-used-keys.ts can actually fail (docs/dev/TESTING.md,
# "Writing a test that can actually fail").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT/scripts/i18n/check-used-keys.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "$TMP/src/components"

cat >"$TMP/fr.json" <<'JSON'
{
  "console.common.action-continue": "Continuer",
  "console.people.invite.action-send_one": "Envoyer 1 invitation",
  "console.people.invite.action-send_other": "Envoyer {{count}} invitations"
}
JSON
cat >"$TMP/en.json" <<'JSON'
{
  "console.common.action-continue": "Continue",
  "console.people.invite.action-send_one": "Send 1 invitation",
  "console.people.invite.action-send_other": "Send {{count}} invitations"
}
JSON

run_check() {
  node "$CHECK" --src "$TMP/src" --fr "$TMP/fr.json" --en "$TMP/en.json"
}

# Control: a source file using only known keys, including a pluralised one,
# must pass — otherwise the failure proven below could just be the checker
# rejecting everything.
cat >"$TMP/src/components/Known.tsx" <<'TSX'
export function Known() {
  const a = t('console.common.action-continue')
  const b = t("console.people.invite.action-send", { count: 3 })
  return a + b
}
TSX
if ! run_check >"$TMP/valid.log" 2>&1; then
  cat "$TMP/valid.log" >&2
  fail "checker rejected a source file that only uses known keys"
fi
grep -q 'checked 2 key usage' "$TMP/valid.log" || fail "checker did not report the expected usage count"
rm "$TMP/src/components/Known.tsx"

# Case: a key absent from both catalogues must fail.
cat >"$TMP/src/components/Unknown.tsx" <<'TSX'
export function Unknown() {
  return t('console.common.action-does-not-exist')
}
TSX
if run_check >"$TMP/invalid.log" 2>&1; then
  cat "$TMP/invalid.log" >&2
  fail "checker accepted a source file referencing an unknown key"
fi
grep -qi 'unknown message-catalogue key' "$TMP/invalid.log" || fail "failure did not name the unknown key"

echo "OK — check-used-keys.ts accepts known keys (including a plural) and rejects an unknown one."

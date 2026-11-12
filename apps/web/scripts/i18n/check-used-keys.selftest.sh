#!/usr/bin/env bash
# Proves scripts/i18n/check-used-keys.ts can actually fail (docs/dev/TESTING.md,
# "Writing a test that can actually fail"): each of its three checks is shown
# rejecting the fault it exists for, against a small fixture application.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT/scripts/i18n/check-used-keys.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# The fixture: an entry that renders one shared word, and one lazy area behind
# the organisation layout that renders its own namespace. Each case gets a
# fresh copy under its own name, so no case inherits another's fault.
FIX=""
new_fixture() {
  FIX="$TMP/$1"
  mkdir -p "$FIX/src/app" "$FIX/src/components" "$FIX/src/features/people" \
    "$FIX/src/i18n/catalogues/fr" "$FIX/src/i18n/catalogues/en"

  cat >"$FIX/src/i18n/namespaces.ts" <<'TS'
export const MESSAGE_NAMESPACES = ['common', 'people'] as const
export const ENTRY_NAMESPACES = ['common'] as const
TS
  cat >"$FIX/src/i18n/index.ts" <<'TS'
export async function withNamespaces<T>(_namespaces: readonly string[], load: () => Promise<T>) {
  return load()
}
TS
  cat >"$FIX/src/i18n/catalogues/fr/common.json" <<'JSON'
{ "console.common.action-continue": "Continuer" }
JSON
  cat >"$FIX/src/i18n/catalogues/en/common.json" <<'JSON'
{ "console.common.action-continue": "Continue" }
JSON
  cat >"$FIX/src/i18n/catalogues/fr/people.json" <<'JSON'
{
  "console.people.invite.action-send_one": "Envoyer 1 invitation",
  "console.people.invite.action-send_other": "Envoyer {{count}} invitations"
}
JSON
  cat >"$FIX/src/i18n/catalogues/en/people.json" <<'JSON'
{
  "console.people.invite.action-send_one": "Send 1 invitation",
  "console.people.invite.action-send_other": "Send {{count}} invitations"
}
JSON
  cat >"$FIX/src/i18n/fr.json" <<'JSON'
{
  "console.common.action-continue": "Continuer",
  "console.people.invite.action-send_one": "Envoyer 1 invitation",
  "console.people.invite.action-send_other": "Envoyer {{count}} invitations"
}
JSON
  cat >"$FIX/src/i18n/en.json" <<'JSON'
{
  "console.common.action-continue": "Continue",
  "console.people.invite.action-send_one": "Send 1 invitation",
  "console.people.invite.action-send_other": "Send {{count}} invitations"
}
JSON

  cat >"$FIX/src/main.tsx" <<'TSX'
import { Known } from './components/Known'
import { ROUTE_UNITS } from './app/routeUnits'
export const boot = () => [Known, ROUTE_UNITS]
TSX
  cat >"$FIX/src/components/Known.tsx" <<'TSX'
export function Known() {
  return t('console.common.action-continue')
}
TSX
  cat >"$FIX/src/app/routeUnits.ts" <<'TS'
import { withNamespaces } from '../i18n'
export const ROUTE_UNITS = {
  organisation: { load: () => withNamespaces([], () => import('./org-route')) },
  people: { load: () => withNamespaces(['people'], () => import('../features/people/routes')) },
}
TS
  cat >"$FIX/src/app/org-route.tsx" <<'TSX'
export const orgRoute = () => t("console.common.action-continue")
TSX
  cat >"$FIX/src/features/people/routes.tsx" <<'TSX'
export const peopleRoute = () => t("console.people.invite.action-send", { count: 3 })
TSX
}

run_check() {
  (cd "$FIX" && node "$CHECK" --src src)
}

# What a refusal must look like: the check fails, and says why in these words.
expect_refusal() {
  local needle="$1"
  if run_check >"$FIX/check.log" 2>&1; then
    cat "$FIX/check.log" >&2
    fail "$(basename "$FIX"): the checker accepted it"
  fi
  grep -qF -- "$needle" "$FIX/check.log" || {
    cat "$FIX/check.log" >&2
    fail "$(basename "$FIX"): the failure did not say \"$needle\""
  }
}

# Control: the fixture as written — known keys only, a pluralised one among
# them, the area's namespace named at its boundary — must pass. Otherwise every
# failure proven below could just be the checker rejecting everything.
new_fixture control
if ! run_check >"$FIX/check.log" 2>&1; then
  cat "$FIX/check.log" >&2
  fail "checker rejected a fixture that only uses known keys behind the right boundaries"
fi
grep -q 'checked 3 key usage' "$FIX/check.log" || fail "checker did not report the expected usage count"
grep -q 'checked 2 namespace catalogue' "$FIX/check.log" || fail "checker did not read the namespace catalogues"
grep -q 'checked the namespaces of 2 lazy route' "$FIX/check.log" || fail "checker did not find the two lazy routes"

# Case 1: a key absent from every namespace catalogue must fail.
new_fixture unknown-key
cat >"$FIX/src/components/Unknown.tsx" <<'TSX'
export function Unknown() {
  return t('console.common.action-does-not-exist')
}
TSX
expect_refusal 'unknown message-catalogue key: console.common.action-does-not-exist'

# Case 2: a key the whole catalogue defines and no namespace catalogue carries
# must fail — it is a key the unit suite would find and no browser would be sent.
new_fixture absent-from-namespaces
cat >"$FIX/src/i18n/fr.json" <<'JSON'
{
  "console.common.action-cancel": "Annuler",
  "console.common.action-continue": "Continuer",
  "console.people.invite.action-send_one": "Envoyer 1 invitation",
  "console.people.invite.action-send_other": "Envoyer {{count}} invitations"
}
JSON
cat >"$FIX/src/components/Cancel.tsx" <<'TSX'
export const Cancel = () => t('console.common.action-cancel')
TSX
expect_refusal 'key in fr.json is in no fr namespace catalogue'
grep -qF 'unknown message-catalogue key: console.common.action-cancel' "$FIX/check.log" ||
  fail "a key in no namespace catalogue was still counted as defined for the code that uses it"

# Case 3: a key one locale's namespace has and the other's lacks must fail.
new_fixture namespace-parity
cat >"$FIX/src/i18n/catalogues/en/people.json" <<'JSON'
{ "console.people.invite.action-send_one": "Send 1 invitation" }
JSON
expect_refusal \
  'key in fr/people.json is missing from en/people.json: console.people.invite.action-send_other'

# Case 4: a namespace one locale has and the other lacks must fail.
new_fixture namespace-missing-locale
rm "$FIX/src/i18n/catalogues/en/people.json"
expect_refusal 'namespace "people" has a fr catalogue and no en one'

# Case 5: a key filed under a namespace other than its own must fail.
new_fixture misfiled-key
cat >"$FIX/src/i18n/catalogues/fr/common.json" <<'JSON'
{
  "console.common.action-continue": "Continuer",
  "console.people.invite.action-send_one": "Envoyer 1 invitation"
}
JSON
expect_refusal 'fr/common.json holds a key of another namespace (people)'

# Case 6: a route that does not name the namespace its screen reads must fail.
new_fixture route-missing-namespace
cat >"$FIX/src/app/routeUnits.ts" <<'TS'
import { withNamespaces } from '../i18n'
export const ROUTE_UNITS = {
  organisation: { load: () => withNamespaces([], () => import('./org-route')) },
  people: { load: () => withNamespaces([], () => import('../features/people/routes')) },
}
TS
expect_refusal \
  'reachable from the "people" route unit, where the "people" namespace is not loaded'

# Case 7: the entry reaching, by a static import, a screen that reads a
# namespace the entry does not carry must fail.
new_fixture entry-reads-area
cat >"$FIX/src/main.tsx" <<'TSX'
import { Known } from './components/Known'
import { ROUTE_UNITS } from './app/routeUnits'
import { peopleRoute } from './features/people/routes'
export const boot = () => [Known, ROUTE_UNITS, peopleRoute]
TSX
expect_refusal \
  'reachable from the application entry, where the "people" namespace is not loaded'

# Case 8: a boundary naming something that is not a namespace must fail.
new_fixture unknown-namespace
cat >"$FIX/src/app/routeUnits.ts" <<'TS'
import { withNamespaces } from '../i18n'
export const ROUTE_UNITS = {
  organisation: { load: () => withNamespaces([], () => import('./org-route')) },
  people: { load: () => withNamespaces(['peeple'], () => import('../features/people/routes')) },
}
TS
expect_refusal 'names "peeple", which is not a message namespace'

# Case 9: a key built at run time is read by its fixed head. An area that
# builds a key of a namespace it was not given must fail like one that names it.
new_fixture built-key
cat >"$FIX/src/app/org-route.tsx" <<'TSX'
export const orgRoute = (state: string) => t(`console.people.invite.status-${state}`)
TSX
expect_refusal \
  'reachable from the "organisation" route unit, where the "people" namespace is not loaded'

# Case 10: a translation taken when a module is evaluated must fail, even for a
# namespace its route names: the module can be evaluated before the catalogue
# has arrived.
new_fixture module-scope-translation
cat >"$FIX/src/features/people/routes.tsx" <<'TSX'
import i18n from '../../i18n'
const title = i18n.t("console.people.invite.action-send", { count: 3 })
export const peopleRoute = () => title
TSX
expect_refusal 'i18n.t(…) is called at module scope'

# Control for inheritance: an area may count on the organisation layout's
# namespaces. Naming `people` at the layout instead of at the area passes;
# case 6 already proved it is refused when it is named nowhere.
new_fixture inherited
cat >"$FIX/src/app/routeUnits.ts" <<'TS'
import { withNamespaces } from '../i18n'
export const ROUTE_UNITS = {
  organisation: { load: () => withNamespaces(['people'], () => import('./org-route')) },
  people: { load: () => withNamespaces([], () => import('../features/people/routes')) },
}
TS
run_check >"$FIX/check.log" 2>&1 || {
  cat "$FIX/check.log" >&2
  fail "an area was refused a namespace the organisation layout names"
}

echo "OK — check-used-keys.ts accepts a sound fixture and rejects an unknown key, a key in no namespace catalogue, a locale parity gap in a namespace, a namespace missing from a locale, a misfiled key, a route without its namespace, an entry that reads an area's namespace, an unknown namespace, a built key of a namespace that is not loaded, and a translation taken at module scope."

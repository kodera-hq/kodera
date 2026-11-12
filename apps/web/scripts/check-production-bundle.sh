#!/usr/bin/env bash
# Proves the mock identity provider and the MSW worker are excluded from a
# production build, not merely disabled at runtime. MFA feature simulation is
# checked independently of those earlier infrastructure markers.
#
# console PR #35, reviewed at 75deb37: `.env.example` claimed the mock-IdP
# route and its handlers existed in the bundle only when `VITE_AUTH_MODE=mock`,
# but a build with `VITE_AUTH_MODE=oidc VITE_ENABLE_MSW=0` still emitted
# `/__mock-idp/authorize`, the `mock-authorization-code` literal, the handler,
# and the msw module itself, because `src/config.ts` read
# `import.meta.env[name]` with a variable key — which Vite cannot replace at
# build time — so the gate in `src/app/routeTree.ts` only ever ran at
# runtime, never at bundle time. This script builds the way the reviewer did
# and greps the same strings, so that failure cannot come back silently.
#
# Round 3 added a fifth check: `mockServiceWorker.js` shipped at the dist
# root regardless of mode, because it lived under `public/`, which Vite
# copies to every build unconditionally. It now lives at `msw/` and is copied
# in only for a mock build (`vite.config.ts`); this script asserts it is
# absent from every other build's dist root.
#
# Round 4 added the demo seed's own literals (`DEMO_LITERALS` below): the
# walkable demo ships a fictional customer's whole dataset and a `?demo=1`
# entry point that selects it, and neither belongs in a build a customer loads.
# Round 4 added the messaging demo preview's own literals
# (`MESSAGING_DEMO_LITERALS` below): a picture of Tchap, the La Suite
# messaging service kodera.io integrates, built so an owner can show a
# customer what their suite looks like. This repository implements no
# messenger, so a fictional conversation reaching a customer's own console
# would be a claim about the product, not only dead weight.
#
# Usage:
#   scripts/check-production-bundle.sh [outDir]
#     The real check: builds with VITE_AUTH_MODE=oidc VITE_ENABLE_MSW=0 and
#     fails if the emitted JS contains any forbidden literal. `outDir`
#     defaults to a temporary directory that is removed afterwards.
#
#   scripts/check-production-bundle.sh --mode mock [outDir]
#     For the selftest only: builds a mock configuration, which legitimately
#     ships every literal below, so the check must fail here. This is what
#     proves the check can actually fail (docs/dev/TESTING.md).
#
#   scripts/check-production-bundle.sh --profile staging [outDir]
#     The staging build the release playbook makes (deployment profiles
#     `core_release_console_build_env`): the same checks, except that it is built
#     with VITE_FIRST_OWNER_JOURNEY=1 and must CARRY the first-owner claim route
#     and its sign-in callback instead of omitting them. `npm run build:check`
#     runs both profiles. Only `/claim/$organisationId` proves the journey is
#     built in: `auth/claim-callback` is in the production build too
#     (src/auth/oidc.ts), and is required here only so the scan matches the
#     needles deployment profiles reads back. The same flag also opens order
#     placement (src/features/order/submission.ts, SUBMISSION_HELD).
#
#   --scan-only <outDir> scans an existing build, for isolated mutations.
#   --msw 0|1 overrides the flag to test a mixed configuration.
#   --mfa-only limits inspection to MFA simulation for those mixed controls.
#   CI uses none of these options: its default builds and checks all categories.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="oidc"
profile="production"
outDir=""
enableMsw=""
scanOnly=0
mfaOnly=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      mode="$2"
      shift 2
      ;;
    --msw)
      enableMsw="$2"
      shift 2
      ;;
    --profile)
      profile="$2"
      shift 2
      ;;
    --scan-only)
      scanOnly=1
      shift
      ;;
    --mfa-only)
      mfaOnly=1
      shift
      ;;
    *)
      outDir="$1"
      shift
      ;;
  esac
done

case "$mode" in oidc|mock) ;; *) echo "invalid auth mode" >&2; exit 1 ;; esac
case "$profile" in production|staging) ;; *) echo "invalid profile" >&2; exit 1 ;; esac
journey=0
[ "$profile" = "staging" ] && journey=1
if [ "$scanOnly" = 1 ] && [ -z "$outDir" ]; then
  echo "--scan-only requires an existing output directory" >&2
  exit 1
fi

cleanup_tmp=""
if [ -z "$outDir" ]; then
  cleanup_tmp="$(mktemp -d)"
  outDir="$cleanup_tmp/dist"
fi
cleanup() {
  # `|| true`: this runs as an EXIT trap, whose own last exit status would
  # otherwise become the script's — turning a clean pass into a false
  # failure whenever there was nothing to clean up (`outDir` was given
  # explicitly, so `cleanup_tmp` is empty and the `-n` test itself fails).
  [ -n "$cleanup_tmp" ] && rm -rf "$cleanup_tmp"
  return 0
}
trap cleanup EXIT

if [ -z "$enableMsw" ]; then
  enableMsw="0"
  [ "$mode" = "mock" ] && enableMsw="1"
fi
case "$enableMsw" in 0|1) ;; *) echo "invalid MSW flag" >&2; exit 1 ;; esac

# --scan-only supports isolated mutation fixtures without rebuilding them.
# --mfa-only checks mixed configurations independently of their test transport.
# CI's default invocation always builds and checks every category.
# Espace's development override (`VITE_ESPACE_DEV_HOMESERVER`, `src/config.ts`): set at build,
# it must still not reach a production build, where `import.meta.env.DEV` folds its read away.
DEV_HOMESERVER="http://127.0.0.1:65530"
# And its server name (`VITE_ESPACE_DEV_SERVER_NAME`), under the same rule.
DEV_SERVER_NAME="dev-only-server-name.invalid"

if [ "$scanOnly" = 0 ]; then
  echo "check-production-bundle: building $profile (VITE_AUTH_MODE=$mode VITE_ENABLE_MSW=$enableMsw VITE_FIRST_OWNER_JOURNEY=$journey) -> $outDir" >&2
  VITE_AUTH_MODE="$mode" \
  VITE_FIRST_OWNER_JOURNEY="$journey" \
  VITE_ENABLE_MSW="$enableMsw" \
  VITE_CORE_API_URL="http://localhost:8000/api/v1" \
  VITE_KEYCLOAK_URL="http://localhost:8080" \
  VITE_OIDC_CLIENT_ID="console" \
  VITE_MATRIX_DOMAIN="kodera.invalid" \
  VITE_ESPACE_DEV_HOMESERVER="$DEV_HOMESERVER" \
  VITE_ESPACE_DEV_SERVER_NAME="$DEV_SERVER_NAME" \
    npx --prefix "$root" --yes vite build --config "$root/vite.config.ts" --outDir "$outDir" --emptyOutDir >&2
fi

# The exact literals the review at 75deb37 grepped for. Each one is either
# unique to the mock identity provider's own source, or — `mockServiceWorker`
# — the file name msw's `setupWorker` requests, which appears nowhere outside
# the msw package itself.
LITERALS=(
  "__mock-idp"
  "mock-authorization-code"
  "mock-idp"
  "mockServiceWorker"
  "MOCK_ACTIVATE"
  "INTEGRITY_CHECK_REQUEST"
  # The demo organisation's own mark (`src/mocks/demo/brand/vercelli-mark.svg`,
  # imported `?inline` by `src/mocks/demo/branding.ts`). Groupe Vercelli is
  # fictional and belongs to the demo seed; the Core contract carries no
  # branding field, so a production build that shipped this would be shipping
  # a customer's identity it has no way to have been given. The literal is the
  # `aria-label` inside the mark, which survives into the data URI `?inline`
  # produces and is the one word in that URI no other source could emit.
  "Vercelli"
)

# The walkable demo's seed (docs/dev/DEMO.md): a whole fictional customer —
# its name, its people, its invoices — plus the `?demo=1` entry point that
# selects it. It reaches the browser only through `src/mocks/browser.ts`,
# which `src/main.tsx` imports behind the same literal `VITE_ENABLE_MSW === '1'`
# comparison the rest of MSW is gated on, so it is excluded by exactly the
# mechanism above and is checked here for exactly the same reason: the gate is
# a build-time fold nobody sees fail. Grouped with the mock-IdP literals rather
# than given a flag of its own, because a build that legitimately ships MSW
# (`--msw 1`) legitimately ships the seed with it.
#
# All three are written as whole strings in the seed. A value the seed
# composes — the persona's address, `i.kaci@${DEMO_EMAIL_DOMAIN}` — is NOT a
# literal after minification (`"i.kaci@"+e`) and would match nothing in any
# build, in a check whose whole point is that it can fail; the self-test's
# positive control against a mock build is what catches that mistake.
DEMO_LITERALS=(
  "demo.groupe-vercelli"
  "Groupe Vercelli"
  "groupe-vercelli.fr"
  "kodera.demo.local-workspaces"
)
LITERALS+=("${DEMO_LITERALS[@]}")
# The messaging demo preview (`src/features/messaging/`): a picture of Tchap,
# the La Suite messaging service kodera.io integrates
# (`contracts/core-api.openapi.yaml`, `TenantApp.app`
# `enum: [visio, docs, drive, tchap, grist]`). This repository implements no
# messenger, and a fictional conversation inside a customer's own console
# would claim otherwise — so it is excluded by the same mechanism as the mock
# identity provider (a literal `import.meta.env` comparison guarding a dynamic
# `import()` in `src/app/routeTree.ts`) and checked here for the same reason:
# that gate is a build-time fold nobody sees fail.
#
# One literal per layer, so no single rename can quietly empty this check:
#   - the route path, written only in `src/features/messaging/demo-route.tsx`;
#   - the surface's root marker attribute, the same move
#     `data-mfa-enrolment-simulation` makes;
#   - a whole sentence out of the fixture, which is what actually must not
#     reach a customer. It is written as one string in
#     `src/features/messaging/demo-fixture.ts` and so survives minification
#     intact; a sentence the fixture COMPOSED would not, and would match
#     nothing in any build.
# Grouped with the mock-IdP literals rather than given a flag of its own,
# because the build that legitimately ships the mock identity provider is
# exactly the build that legitimately ships this preview.
#
# What this does NOT cover, said plainly so nobody reads more into it than
# it proves: the surface's own LABELS live in the message catalogues, and
# every namespace catalogue is emitted with every build
# (`src/i18n/index.ts` lists them all as deferred files), so the
# `console.messaging.demo.*` keys ship in every build as a file of their own
# — exactly as the `console.mockidp` key does. Those are strings in a file
# only the route this script proves absent would ever fetch. The route, the
# surface and the fixture are what must not ship, and they are what the
# three literals below actually check.
MESSAGING_DEMO_LITERALS=(
  "__demo-messaging"
  "data-messaging-demo-surface"
  "Coulage de la dalle R+2"
)
LITERALS+=("${MESSAGING_DEMO_LITERALS[@]}")

# The first-owner journey (`VITE_FIRST_OWNER_JOURNEY`, off by default): its route path, written
# only in `src/features/owner-claim/route.tsx`, must not reach a build without the flag. The
# staging profile is built with the flag and must carry it instead (checked below).
CLAIM_LITERALS=('/claim/$organisationId' 'auth/claim-callback')
[ "$profile" = "production" ] && LITERALS+=('/claim/$organisationId')
# The development override's value, set at build above.
LITERALS+=("$DEV_HOMESERVER" "$DEV_SERVER_NAME")

# These are emitted by the MFA simulation itself, not the mock login route.
# Its lazy import and local completion flag must disappear independently.
MFA_LITERALS=(
  "JBSWY3DPEHPK3PXP"
  "kodera.web.mfa.enrolledLocally"
  "kodera-codes-de-secours.txt"
  "data-mfa-enrolment-simulation"
  "mfa_enrolment_completed"
)
if [ "$mfaOnly" = 1 ]; then LITERALS=(); fi
LITERALS+=("${MFA_LITERALS[@]}")

assets="$outDir/assets"
if [ ! -d "$assets" ]; then
  echo "check-production-bundle: no $assets directory — did the build actually run?" >&2
  exit 1
fi

shopt -s nullglob
jsFiles=("$assets"/*.js)
if [ "${#jsFiles[@]}" -eq 0 ]; then
  echo "check-production-bundle: no emitted JavaScript to inspect" >&2
  exit 1
fi

found=0
for literal in "${LITERALS[@]}"; do
  if [ "$literal" = "mockServiceWorker" ]; then
    # One inert filename comparison in the import-free bootstrap retires obsolete workers.
    # No other occurrence is admitted, including a second marker in that same asset.
    matches="$(python3 - "${jsFiles[@]}" <<'PY'
import pathlib
import re
import sys

for name in sys.argv[1:]:
    code = pathlib.Path(name).read_text()
    if (all(marker in code for marker in (
            'ENTRY_HEAD_MARKUP_MISSING', 'kodera.web.legacy-worker-reload',
            '.getRegistrations()', '.unregister()'))
            and code.count('mockServiceWorker') == 1):
        code = re.sub(r'([\"\'`])/mockServiceWorker\.js\1', '"retired-worker"', code)
    if 'mockServiceWorker' in code:
        print(name)
PY
)"
  else
    matches="$(grep -rl -F -- "$literal" "${jsFiles[@]}" 2>/dev/null || true)"
  fi
  if [ -n "$matches" ]; then
    found=1
    echo "check-production-bundle: found '$literal' in:" >&2
    echo "$matches" | sed 's/^/  /' >&2
  fi
done

# `msw`'s service worker SCRIPT ITSELF, at the dist root — not a JS literal,
# a real static file `navigator.serviceWorker.register()` fetches
# (`vite.config.ts`'s `mockServiceWorkerPlugin`). Round 2 of this fix excluded
# the mock IdP and msw's module code from the assets above; the worker file
# still shipped, copied unconditionally out of `public/` by Vite's own
# `publicDir` handling, until it moved to `msw/` and became build-mode-gated.
# Legitimate in a mock build (`mode = mock`), forbidden in every other one.
worker_at_root="$outDir/mockServiceWorker.js"
if [ "$mfaOnly" = 0 ] && [ "$mode" != "mock" ] && [ -f "$worker_at_root" ]; then
  found=1
  echo "check-production-bundle: found $worker_at_root — msw's worker script must not ship in a $mode build" >&2
fi

# The demo mark as a FILE, not a literal — the other half of the same check.
# `?inline` is what keeps it a string inside a module the mock gate removes; a
# plain asset import would make Vite emit it into `assets/` instead, and an
# emitted asset survives the tree-shaking of the module that referenced it. So
# the literal check above cannot see that regression, and this can: nothing
# anywhere under the dist root may be named after it.
if [ "$mfaOnly" = 0 ]; then
  demo_assets="$(find "$outDir" -iname '*vercelli*' 2>/dev/null || true)"
  if [ -n "$demo_assets" ]; then
    found=1
    echo "check-production-bundle: found a demo branding asset emitted into the build:" >&2
    echo "$demo_assets" | sed 's/^/  /' >&2
  fi
fi

if [ "$profile" = "staging" ] && [ "$mfaOnly" = 0 ]; then
  for literal in "${CLAIM_LITERALS[@]}"; do
    if ! grep -rqF -- "$literal" "${jsFiles[@]}" 2>/dev/null; then
      found=1
      echo "check-production-bundle: missing '$literal' — the staging build must serve the first-owner claim" >&2
    fi
  done
fi

if [ "$found" -ne 0 ]; then
  echo "check-production-bundle: FAILED — the build carries forbidden simulation or test infrastructure code" >&2
  exit 1
fi

echo "check-production-bundle: OK ($profile) — no forbidden simulation, demo, messaging-demo or MFA literals in $assets/*.js (MFA-only=$mfaOnly)"

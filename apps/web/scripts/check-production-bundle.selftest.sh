#!/usr/bin/env bash
# Proves scripts/check-production-bundle.sh can actually fail (docs/dev/TESTING.md,
# "Writing a test that can actually fail").
#
# Control: an oidc/no-msw build — the shape console PR #35 is meant to ship —
# must pass, otherwise the mutation below could just be the script rejecting
# every build regardless of what it finds.
#
# Mutation: a mock build legitimately ships the mock identity provider, MSW, the
# walkable demo's seed and the messaging demo preview, so the check must reject
# it. If it stopped doing that, `npm run build:check` would stay green on a
# regression back to the original bug.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/check-production-bundle.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "check-production-bundle.selftest: FAIL: $1" >&2
  exit 1
}

if ! "$check" "$tmp/oidc" >"$tmp/oidc.log" 2>&1; then
  cat "$tmp/oidc.log" >&2
  fail "a production (VITE_AUTH_MODE=oidc VITE_ENABLE_MSW=0) build was rejected"
fi
grep -q "OK" "$tmp/oidc.log" || fail "the production build did not report OK"
# Round 3: msw's service worker script must not reach the dist root of a
# production build (it used to, unconditionally, via `public/` — see
# vite.config.ts's `mockServiceWorkerPlugin`).
[ -f "$tmp/oidc/mockServiceWorker.js" ] &&
  fail "a production build emitted mockServiceWorker.js at its dist root"

if "$check" --mode mock "$tmp/mock" >"$tmp/mock.log" 2>&1; then
  cat "$tmp/mock.log" >&2
  fail "a mock build (VITE_AUTH_MODE=mock VITE_ENABLE_MSW=1) was not rejected"
fi
grep -q "__mock-idp" "$tmp/mock.log" || fail "the rejection did not name __mock-idp"
grep -q "mock-authorization-code" "$tmp/mock.log" || fail "the rejection did not name mock-authorization-code"
grep -q "mockServiceWorker" "$tmp/mock.log" || fail "the rejection did not name mockServiceWorker"
# The demo seed's positive control. A mock build carries the whole seeded
# organisation, so the check must name it here; without this the demo literals
# could be misspelt — matching nothing in any build — and the production run
# would still report OK.
grep -q "demo.groupe-vercelli" "$tmp/mock.log" || fail "the rejection did not name the demo scenario"
grep -q "Groupe Vercelli" "$tmp/mock.log" || fail "the rejection did not name the demo organisation"
grep -q "groupe-vercelli.fr" "$tmp/mock.log" || fail "the rejection did not name the demo email domain"
grep -q "kodera.demo.local-workspaces" "$tmp/mock.log" || fail "the rejection did not name the local workspace registry"
# The messaging demo preview's positive control. A mock build carries the whole
# surface, so the check must name it here; without this the three literals
# below could be misspelt — matching nothing in any build — and the production
# run would still report OK, which is the one way this proof can lie.
grep -q "__demo-messaging" "$tmp/mock.log" || fail "the rejection did not name the messaging demo route"
grep -q "data-messaging-demo-surface" "$tmp/mock.log" ||
  fail "the rejection did not name the messaging demo surface marker"
grep -q "Coulage de la dalle R+2" "$tmp/mock.log" ||
  fail "the rejection did not name the messaging demo fixture"
# The mock build's own dist root must still carry the worker script — a mock
# build without it cannot start MSW at all, which the smoke e2e spec would
# catch, but this is the direct control proving the copy plugin still works.
[ -f "$tmp/mock/mockServiceWorker.js" ] ||
  fail "a mock build did not emit mockServiceWorker.js at its dist root"

# Mutate ONLY the already-clean production assets, one MFA marker at a time.
# None of these fixtures includes a mock-IdP/MSW marker, so another category
# cannot accidentally make this proof green.
for marker in \
  'JBSWY3DPEHPK3PXP' \
  'kodera.web.mfa.enrolledLocally' \
  'kodera-codes-de-secours.txt' \
  'data-mfa-enrolment-simulation' \
  'mfa_enrolment_completed'; do
  printf 'void "%s";\n' "$marker" > "$tmp/oidc/assets/mfa-mutation.js"
  if "$check" --scan-only "$tmp/oidc" > "$tmp/mfa-mutation.log" 2>&1; then
    fail "the isolated MFA marker $marker was not rejected"
  fi
  grep -Fq "found '$marker'" "$tmp/mfa-mutation.log" || fail "MFA rejection did not name its marker"
  rm "$tmp/oidc/assets/mfa-mutation.js"
done
"$check" --scan-only "$tmp/oidc" > "$tmp/clean-again.log" 2>&1 || fail "removing the mutation did not restore the clean control"

# The same isolated mutation, one demo marker at a time, against the already
# clean production assets. This is what proves each demo literal is checked on
# its own rather than riding on another category's rejection.
for marker in \
  'demo.groupe-vercelli' \
  'Groupe Vercelli' \
  'groupe-vercelli.fr' \
  'kodera.demo.local-workspaces'; do
  printf 'void "%s";\n' "$marker" > "$tmp/oidc/assets/demo-mutation.js"
  if "$check" --scan-only "$tmp/oidc" > "$tmp/demo-mutation.log" 2>&1; then
    fail "the isolated demo marker $marker was not rejected"
  fi
  grep -Fq "found '$marker'" "$tmp/demo-mutation.log" || fail "demo rejection did not name its marker"
  rm "$tmp/oidc/assets/demo-mutation.js"
done
# The demo branding mark, mutated into the already-clean production assets the
# same way. Two mutations, because the mark can regress two different ways: as
# a string inside a module (`?inline`, what it is today) and as a file Vite
# emitted into the build (a plain asset import, what it must never become —
# an emitted asset outlives the tree-shaking of the module that referenced it,
# so the literal scan alone would stay green through that).
printf 'void "Groupe Vercelli";\n' > "$tmp/oidc/assets/demo-branding-mutation.js"
if "$check" --scan-only "$tmp/oidc" > "$tmp/demo-literal.log" 2>&1; then
  fail "the demo branding literal was not rejected"
fi
grep -Fq "found 'Vercelli'" "$tmp/demo-literal.log" || fail "the demo branding rejection did not name its literal"
rm "$tmp/oidc/assets/demo-branding-mutation.js"

printf '<svg/>\n' > "$tmp/oidc/assets/vercelli-mark-deadbeef.svg"
if "$check" --scan-only "$tmp/oidc" > "$tmp/demo-asset.log" 2>&1; then
  fail "a demo branding asset emitted into the build was not rejected"
fi
grep -Fq "demo branding asset emitted into the build" "$tmp/demo-asset.log" ||
  fail "the emitted-asset rejection did not say what it found"
grep -Fq "vercelli-mark-deadbeef.svg" "$tmp/demo-asset.log" || fail "the emitted-asset rejection did not name the file"
rm "$tmp/oidc/assets/vercelli-mark-deadbeef.svg"
"$check" --scan-only "$tmp/oidc" > "$tmp/clean-after-demo.log" 2>&1 || fail "removing the demo mutations did not restore the clean control"
# The same isolated mutation, one messaging-demo marker at a time, against the
# already clean production assets. This is what proves each of the three
# literals is checked on its own rather than riding on another category's
# rejection — a real risk here, since all three come from the same feature and
# a single grep over the lot would stay green while two of them rotted.
for marker in \
  '__demo-messaging' \
  'data-messaging-demo-surface' \
  'Coulage de la dalle R+2'; do
  printf 'void "%s";\n' "$marker" > "$tmp/oidc/assets/messaging-demo-mutation.js"
  if "$check" --scan-only "$tmp/oidc" > "$tmp/messaging-demo-mutation.log" 2>&1; then
    fail "the isolated messaging demo marker $marker was not rejected"
  fi
  grep -Fq "found '$marker'" "$tmp/messaging-demo-mutation.log" ||
    fail "messaging demo rejection did not name its marker"
  rm "$tmp/oidc/assets/messaging-demo-mutation.js"
done
"$check" --scan-only "$tmp/oidc" > "$tmp/clean-after-messaging-demo.log" 2>&1 ||
  fail "removing the messaging demo mutation did not restore the clean control"
printf 'void "/claim/$organisationId/$organisationSlug";\n' > "$tmp/oidc/assets/claim-route-mutation.js"
if "$check" --scan-only "$tmp/oidc" > "$tmp/claim-route-mutation.log" 2>&1; then
  fail "the first-owner claim route was not rejected"
fi
grep -Fq "found '/claim/\$organisationId'" "$tmp/claim-route-mutation.log" ||
  fail "the claim route rejection did not name its literal"
rm "$tmp/oidc/assets/claim-route-mutation.js"
"$check" --scan-only "$tmp/oidc" > "$tmp/clean-after-claim-route.log" 2>&1 ||
  fail "removing the claim route mutation did not restore the clean control"
printf 'void "http://127.0.0.1:65530";\n' > "$tmp/oidc/assets/dev-homeserver-mutation.js"
if "$check" --scan-only "$tmp/oidc" > "$tmp/dev-homeserver-mutation.log" 2>&1; then
  fail "Espace's development homeserver was not rejected"
fi
grep -Fq "found 'http://127.0.0.1:65530'" "$tmp/dev-homeserver-mutation.log" ||
  fail "the development homeserver rejection did not name its literal"
rm "$tmp/oidc/assets/dev-homeserver-mutation.js"
"$check" --scan-only "$tmp/oidc" > "$tmp/clean-after-dev-homeserver.log" 2>&1 ||
  fail "removing the development homeserver mutation did not restore the clean control"

# The staging profile (the release playbook's build, VITE_FIRST_OWNER_JOURNEY=1) must pass and
# carry the claim route; the production assets, scanned as staging, must fail for lacking it.
"$check" --profile staging "$tmp/staging" > "$tmp/staging.log" 2>&1 || {
  cat "$tmp/staging.log" >&2
  fail "the staging build was rejected"
}
grep -Fq "OK (staging)" "$tmp/staging.log" || fail "the staging build did not report OK"
grep -rqF '/claim/$organisationId' "$tmp/staging/assets" || fail "the staging build does not carry the claim route"
if "$check" --profile staging --scan-only "$tmp/oidc" > "$tmp/staging-without-claim.log" 2>&1; then
  fail "a staging scan of a build without the claim route was not rejected"
fi
grep -Fq "missing '/claim/\$organisationId'" "$tmp/staging-without-claim.log" ||
  fail "the staging rejection did not name the missing claim route"
printf 'void "__mock-idp";\n' > "$tmp/staging/assets/staging-mock-mutation.js"
if "$check" --profile staging --scan-only "$tmp/staging" > "$tmp/staging-mock.log" 2>&1; then
  fail "the mock identity provider in a staging build was not rejected"
fi
grep -Fq "found '__mock-idp'" "$tmp/staging-mock.log" || fail "the staging mock rejection did not name its marker"
rm "$tmp/staging/assets/staging-mock-mutation.js"

# Either mixed configuration must omit MFA simulation even when a test
# transport is present. Explicit mock + MSW remains the positive control.
"$check" --mode oidc --msw 1 --mfa-only "$tmp/oidc-msw" > "$tmp/oidc-msw.log" 2>&1 || fail "OIDC with MSW emitted MFA simulation"
"$check" --mode mock --msw 0 --mfa-only "$tmp/mock-no-msw" > "$tmp/mock-no-msw.log" 2>&1 || fail "mock without MSW emitted MFA simulation"
if "$check" --scan-only --mfa-only "$tmp/mock" > "$tmp/mfa-positive.log" 2>&1; then
  fail "the explicit mock build did not retain the demonstration"
fi
grep -Fq "found 'JBSWY3DPEHPK3PXP'" "$tmp/mfa-positive.log" || fail "mock MFA seed missing from positive control"
grep -Fq "found 'kodera-codes-de-secours.txt'" "$tmp/mfa-positive.log" || fail "mock MFA recovery generation missing from positive control"

echo "check-production-bundle.selftest: OK — production and both mixed configurations omit MFA simulation; five isolated MFA mutations, four isolated demo-seed mutations, both demo-branding mutations, three isolated messaging-demo mutations, the claim route mutation and the development homeserver mutation fail; the staging build carries the claim route and still refuses the mock identity provider; the explicit mock control retains its demonstration, its demo seed, its demo mark, its messaging preview and its worker"

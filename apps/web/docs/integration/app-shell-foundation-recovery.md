# Continue the application shell on the reviewed components

Status: Validated; pending independent review

## Scope

Continue existing PR35 at `459b920` with a normal merge of composites `197b9b7`.
Reuse its real application entry, providers, routing, identity adapter and mock
smoke journey. Preserve the newer form/data accessibility corrections, component
token dependency and stronger guards without replacing the shell implementation.
The later login, logout, renewal, dialog-focus and MFA corrections retain their
existing branches and must be integrated before customer readiness is claimed.

No new Core endpoint or fixture is needed. Preserve the existing production-bundle
refusal check and CI wiring. Do not add workflows, repository-rule changes or
real identity/provider calls. Existing AreaStub routes remain unfinished scope;
a runnable scaffold is not completion of those features or the full mock.

## Acceptance before integration

```sh
git diff --exit-code 197b9b7 -- tests/unit/ui/spacing-guard.ts tests/unit/ui/fixtures src/ui/FileDrop src/ui/RadioGroup
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run build:check
scripts/check-production-bundle.selftest.sh
npm run test:e2e -- --project=chromium
```

The preservation command must fail before integration and pass afterwards.
Retain the shell's higher scanner inventory thresholds, existing generated radio
CSS acceptance and meaningful refusal mutations. Verify dependency resolution
as the union of the reviewed component lockfile and existing shell additions.

The real application entry must now build, unlike the earlier component-only
branches. The synthetic sign-in smoke journey must pass and the OIDC/no-MSW
build must exclude the mock identity provider and service worker. This does not
prove a live identity provider, completed customer screens or newly admitted
Core routes. Record merge choices, actual checks and remaining blockers before
independent review; no push before that review.

## Table conflict acceptance

The merge exposes two independent prior fixes in the same header class: the
shell uses ink-2 for readable small text; the component foundation removes
undeclared tracking-wide and adds keyboard-reachable scrolling. Preserve both.
The new regression reads the rendered header and background token classes,
resolves their actual palette values and requires a contrast ratio of at least
4.5. It must fail against the incoming ink-3 header before keeping the existing
shell ink-2 correction. This is reuse of an existing correction, not a new
palette choice or an exemption from the full-mock contrast decision.

## Integration and validation evidence

The initial preservation check failed. The normal merge produced three file
conflicts: package.json, package-lock.json and Table. Both JSON files resolved
as a semantic three-way union without conflicting values. Every inherited
component dependency entry remains unchanged; thirteen added package entries
match the original shell exactly. A clean locked install succeeded without
running dependency scripts.

The table retains the component foundation's keyboard-reachable region and
removal of undeclared letter spacing, plus the shell's existing ink-2 contrast
correction. The new rendered-token contrast test first failed at 4.317366:1 on
ink-3, then passed with the preserved ink-2 choice. This avoids losing either
fix through a wholesale conflict-side selection. Other original shell/app/auth
and mock source files, production-bundle scripts and workflow wiring remain
byte-identical to the original shell head. Guard implementation and refusal
fixtures match the reviewed components, retaining the shell's higher floors.

All 802 tests in 78 files pass with two workers. Types, formatting and the real
application build pass. ESLint has zero errors and the inherited DocumentViewer
unused-disable warning. The production-bundle self-test passes its clean OIDC
control and deliberate mock rejection. The Chromium synthetic sign-in smoke
journey passes with server reuse disabled on a verified free loopback port;
its owned server was stopped afterwards. Advisory bundle-size warnings remain.

This is a runnable shell against synthetic services. Placeholder areas, actual
Core/provider integration, the newer login/security branches and exact complete
mock fidelity remain outstanding. No customer readiness is claimed.

# Vitest 5 migration

Status: Integrated by #143; protected PR and main CI passed.

## Scope

Move the unit runner from Vitest 4.1.11 to 5.0.1. Keep Vite 8.3.0, jsdom 30.0.1, the npm 10.9.2 package-manager declaration and the selected Node 22 major. The retained dependency graph requires `^22.22.2 || ^24.15.0 || >=26.0.0`; jsdom sets the strictest lower boundaries. `.nvmrc` remains `22` for ordinary development and CI. The unchanged pinned visual container uses Node 24.20.0 and npm 11.19.0 through its existing wrapper, so the supported range also includes that mandatory renderer. Every locked Node engine accepts this full range; this compatibility claim does not mean every admitted Node release has run the entire suite.

The [official migration guide](https://vitest.dev/guide/migration/) explains the new default mock-history clearing and rejection of nested hoisted mocks. Keep those defaults and existing test assertions. Configuration, setup and individual tests change only when a measured compatibility failure requires it. No product, browser configuration, baseline, retry or accessibility-rule change belongs to this migration.

## Guard and refusal proof

The existing `tests/unit/toolchain.test.ts` guard checks the manifest and lockfile range, selected CI Node major, actual stable runtime across the supported release lines and CI selection from `.nvmrc`. Its permanent negative fixtures invoke the same assertions and require the specific refusal message for old/broadened ranges, unsupported runtimes, stale lock metadata and changed selection. Positive and negative boundary cases cover the supported Node 22, 24 and 26 lines, reject unsupported 23/25, and specifically refuse 22.22.1 and 24.14.9. It does not implement a general semver parser.

## Acceptance

Use npm 10.9.2 for a clean `npm ci` without peer bypass. Inspect all lockfile graph changes; record intentional transitive major crossings by exact path/version in `lockfile-known-downgrades.json`, with their reason and removal condition. Keep unrelated direct dependencies fixed.

Required evidence: dependency audit and refusal self-test; lock direction and self-test; lint, formatting, types, i18n and spec gates with their existing negative proofs; complete unit suite; production build and bundle guard with refusal self-test; complete browser suite and pinned visual suite, with existing baselines and zero retries. A deliberately bypassed toolchain assertion must fail the permanent negative tests. Preserve initial failures and diagnose them instead of weakening assertions or rerunning unchanged visual failures until green.

Local acceptance does not replace protected CI or demonstrate live-service readiness. The migration was integrated onto current main before publication. Replacement #143 is verified and merged; Dependabot automatically closed the superseded proposal #122 because Vitest is up to date.

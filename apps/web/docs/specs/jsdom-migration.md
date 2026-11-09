# jsdom 30.1.1 migration

Status: Locally accepted on merged appearance fix #145; independent review and protected CI pending on Console main base `0d54c820`.

## Scope

Upgrade only the unit-test DOM environment from locked jsdom 30.0.1 to 30.1.1. Keep Vitest 5.0.1, Vite, ESLint, product source, mocked Core API responses, configuration, browser and visual baselines unchanged. This tooling-only change needs no new API mock. The selected runtime remains Node 22.22.2 with npm 10.9.2; the manifest's supported range remains `^22.22.2 || ^24.15.0 || >=26.0.0`, also covering the existing pinned visual renderer on Node 24.20.0. Metadata compatibility across the range is distinct from actually executing tests on every Node release.

## Dependency graph

npm 10.9.2 resolved jsdom 30.1.1 from current main. Its direct dependency declarations require four new transitive majors: `@asamuzakjp/css-color` 6.0.7 to 7.1.2, `@asamuzakjp/dom-selector` 8.3.2 to 9.2.2, `html-encoding-sniffer` 6.0.0 to 7.0.0, and `w3c-xmlserializer` 5.0.0 to 6.0.0. Each exact lock path, reason and removal condition is recorded in `lockfile-known-downgrades.json`. `symbol-tree` disappears because jsdom no longer declares it. The remaining version moves are within their existing majors and must be reviewed as part of the jsdom dependency closure, including its CSS and URL dependencies. No unrelated direct dependency range may change.

## Acceptance

The separate `run-notes/tooling-migrations/jsdom/acceptance.sh` runs npm 10.9.2 clean installation; audit and negative self-test; lock direction and negative self-test against exact base; lint, format, type, i18n, spec and policy gates; full unit tests; production build and bundle check with negative self-test; complete browser suite with an explicit zero-retry override and pinned visual suite. The initial browser attempt on the former base was stopped after a first-run axe color-contrast failure and is not acceptance. Merged appearance fix #145 removes the proven card color transition and adds a frame-level refusal test; one complete zero-retry browser run on this combined tree passed 284/284 cases with one worker. The pinned visual suite passed 43/43 on its first combined-tree run with zero retries. Browser and visual acceptance use the shared heavy-test lock, existing baselines and zero retries. Preserve the first failing result for diagnosis. Independent exact-head technical reviews and current protected CI precede integration; this local note is not a deployment-readiness claim.

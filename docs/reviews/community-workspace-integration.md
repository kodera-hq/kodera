# Community workspace integration review

Status: Validated


Branch: `fix/lane-77-world-class-ux`

Base: `44d01acae5c2db4a211217c9dc2663402ae877e3`

## Product outcome

The routed Community workspace is the reference demo entry. It combines the compact workspace menu and channel sidebar with functional messaging, channel creation, local documents, developer documentation and clearly labelled local audio controls. The retired fictional application and its dependent fixtures/tests have been removed. Reusable appearance and document components live in their product modules.

## Cross-perspective work

| Perspective | Detected | Corrected | Rechecked |
| --- | --- | --- | --- |
| 1. Authentication and session lifecycle | Manual intermediate authorization; warnings above the real expiry threshold; dismissal coupled to renewal; stale membership reads | Automatic demo/silent authorization, mock refresh tokens, 120-second warning threshold, independent dismissal, correct in-flight identity caching | Installed SDK renewal integration, expiry/refusal regressions, real login and reload, one-minute focus test |
| 2. Shell and navigation | Broken community monogram, stacked sidebar controls, duplicate avatar, inaccessible management actions in setup states | Compact KC/domain header, shared workspace menu, complete management and documentation destinations, responsive channel chooser | Shell/menu regressions, setup-state coverage, keyboard and mobile browser checks |
| 3. Workspace features | Retired fictional application, disconnected channel creation, obsolete document editor, dead demo voice entry | Product-module migration, text/voice channel creation, channel-scoped notes/templates/publication, local AudioDock adapter | Store/document/dialog tests; real message, reaction, thread, invitation, note and audio journeys |
| 4. Data consistency | Another organisation's roster/domain/status; non-persistent People writes; lost state on authentication redirects; invalid local fixture identifiers | Scoped community/local responses, persistent People mutations, session-scoped workspace/conversation/document state, stable UUID fixture metadata | Request-level isolation, mutation/idempotency and strict identity/MFA tests; real workspace-switch round trip |
| 5. Code, contracts and production isolation | Dead references, stale documentation, missing exclusion marker for the new registry | Removed obsolete sources and documentation; strengthened bundle exclusion/mutation coverage | Production and staging bundle checks, bundle selftests, SDK tests, attribution and required-clause checks |
| 6. Browser QA and visual review | Reload assets blocked by mock interception, stale browser selectors, cramped mobile header, mobile channel list obscuring chat | Narrow same-origin development asset allowance, current journey tests, responsive header and channel chooser | Chromium journeys on port 5173, screenshots, three-theme WCAG A/AA scans, Console navigation and responsive checks |
| 7. Adversarial engineering/product review | False theme-share/save success, custom colours surviving official selection, invalid/duplicate creation, decoder-only channel limit, invalid support destinations | Acknowledged publication/errors, palette reset, validation, lossless restoration, supported navigation and setup-state fallbacks | Independent source review and regression tests; final browser and repository gates remain the release evidence |

## Validation evidence

- Web typecheck, lint and documentation generation check pass. The final complete unit suite passes all 5,205 tests across 363 files.
- Production and staging `npm run build:check`: mock infrastructure, seed data and local workspace registry are excluded.
- `bash scripts/check-production-bundle.selftest.sh`: mutation controls and explicit mock positive controls pass.
- Root `npm run test:sdk`: 76 tests pass (33 SDK and 43 extension tests).
- Attribution scan and required clauses: pass; 11 required clauses across seven files.
- Browser suite: `npx playwright test --config playwright.community.config.ts` passes all 13 scenarios in three files, with zero skipped, unexpected or flaky results. Three workspace themes have zero detected WCAG A/AA violations. The mobile/session check also passes after the final viewport-unit correction. Preserved evidence lives under `apps/web/playwright-report/lane77-evidence`, with the combined JSON summary at `apps/web/playwright-report/lane77-summary.json`; these are ignored local test artifacts, not production assets.
- The remaining lint warning is the pre-existing form-library compiler compatibility warning in `ContactsStep.tsx`; lint has no errors.
- No targeted fictional identifiers or unfinished TODO/FIXME markers remain. Two TODO strings deliberately exercise the server catalogue checker's negative controls.

The source specification is [community-workspace-polish.md](../specs/community-workspace-polish.md). Re-run commands from the root except web commands, which run in `apps/web`.

## Adversarial decision and limits

Independent adversarial source review gives a scoped GO after closure of every actionable finding identified in this work. Browser acceptance covers the journeys listed above. The committed-tree Genesis rehearsal is performed after this report is committed and reported in the task handoff. This is not a claim that every possible product state is defect-free.

Local creation, conversations, documents and audio are demo capabilities. Audio captures or transmits no media. This work does not certify a deployed Matrix service, live federation, cloud provisioning or multi-user document synchronization. Real identity authorization remains unchanged; fixtures were corrected to satisfy it.

## Publication boundary

The branch starts at the requested base and leaves `main` unchanged. No environment file or protected legacy checkout is modified. No deployment or provider operation is part of this change.

The Genesis script's canonical location is `scripts/cutover/prepare-genesis-commit.sh`. Its final rehearsal must use `--source HEAD --dry-run` after committing the clean feature branch, rather than its default `main` source. The repository has no configured Git remote; publication and a remote pull request are outside this local rehearsal.

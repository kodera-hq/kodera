# Recover the existing login flow on the reviewed UI foundation

Status: Specified before integration

The existing shell/login implementation has no promotion PR onto the recovered route foundation. Its independent authentication corrections already have reviewable dependent PRs. Build one integration branch retaining all their commits and normally merge route foundation cc5ddd0c153a2f1e2502eaf9c09baf97cc32592a into callback head0bed61dadbd1125e25fe5b4b03c3e71df39109e5. Do not recreate screens, squash their histories, alter business behavior or remove old review artifacts. A subsequent reviewed reload fix can join this common lineage before the integration PR is opened.

Before integration `git merge-base --is-ancestor cc5ddd0c153a2f1e2502eaf9c09baf97cc32592a HEAD` must fail; afterward it must pass along with ancestry of0bed61d. Preserve all existing login/auth/API/app/mock and browser files from0bed61d. Preserve all UI components, dependency lock, current-main guards and protected configuration fromcc5ddd0. Any overlap must be reviewed by purpose rather than choosing a whole side. Final application runs the recovered components and the reviewed auth code together.

Run all unit/type/lint/format/build and production exclusion checks. Run the existing authentication browser journeys with unique loopback server ownership. The real SDK callback and refresh-token suites remain mandatory; no restored OTP or production simulation. Independent expert review covers both source composition and any changed effective component behavior. The existing component ring pin and other foundation PRs remain explicit dependencies.

This promotes the administration/login foundation only. Complete collaboration UI, real MFA, real Core authority, first-owner protocol and customer release remain incomplete. Required human reviews remain separate from technical integration evidence. No workflow redesign or infrastructure action follows from this branch.

## Initial integration result

The initial ancestor check failed, then the normal merge completed without
conflicts. Existing authentication, feature, app, API, mock and browser source
matches callback0bed61d exactly. UI components, dependencies, main guards and
protected configuration match routecc5ddd0 exactly.

All 889 unit tests pass. Types, lint, formatting and the production exclusion
check pass, with one inherited DocumentViewer lint warning and the existing
bundle size warning. Thirteen Chromium shell/login/callback journeys pass on an
owned production-mode mock preview. The server was not reused and was stopped
afterward. This is still controlled provider/API evidence. The pending reload
slice will need its own source review and integration acceptance.

## Reviewed reload integration

The independently reviewed reload correction at b98307fb8d45aa57d6f9aa9c60af3d3ec147beb3 can now join the common foundation through a normal merge. Preserve its auth, current-user helper, protected-route and catalogue/test changes, and retain the reviewed route/UI foundation. Re-run the full unit and production gates plus the authentication and reload browser journeys before publication. No unrelated focus or specification-gate branch is included in this promotion slice.

The reload merge completed without conflicts. All twenty changed reload files match the independently reviewed correction exactly; UI, dependency and protected configuration paths retain the reviewed route base. The combined application passes 915 unit tests, type checks, lint, production exclusion checks and 17 Chromium shell/login/callback/reload/logout journeys. The count describes the selected integrated suite, not the sum of overlapping earlier branch suites.

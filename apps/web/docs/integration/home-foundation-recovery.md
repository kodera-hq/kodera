# Recover the existing organisation home

Status: Specification before integration and correction

Continue the existing home screen at af3b681163cde6a8165257abc5780d5997faac86 on reviewed common application foundation 45bfe0a1701a178719790c3beb77e5425a10ae85. Preserve its cards, invitation behavior and explicit contract limitations; this administration overview is not the complete collaboration mock.

Before integration, reproduce these observed source risks with mounted component tests: a failed initial status summary or fallback tenant list must show a recoverable error rather than claim no instance and encourage ordering; a valid fallback tenant ID must reach the active applications query; provisioning entitlements must use the immutable organisation ID, with the slug reserved for navigation. Preserve the positive empty-tenant state after successful authoritative reads.

The home current-user reader must reuse the reviewed generation-scoped loader rather than reintroduce the obsolete bare me cache. Preserve reviewed auth, UI, dependencies and guards through a normal merge. Merge catalogue source additions then regenerate both JSON catalogues; never pick one branch's entire catalogue.

Acceptance: meaningful red component tests before changes, the recovered foundation as ancestor, original invitation/polling/card suites, all unit/type/lint/format/build gates and existing home browser journeys alongside representative authentication/reload journeys. Record every conflict and any retained warning. API fixtures remain synthetic; no current backend authority or measured customer service is claimed.


The initial component probe reproduced four failures with the successful-empty control passing. Two merge conflicts were confined to the browser sign-in helper and catalogue count test. The helper retains both existing entry functions; the catalogue test reuses the exact existing PR46 source (fcaf9de) instead of inventing another row-count literal. Catalogue source additions from both parents were merged and generated. Home now reads the current user already returned by the protected organisation loader, avoiding an extra query/cache owner.

The old browser helper discarded every colour-contrast violation, citing a Table defect now corrected by the recovered foundation. Remove that blanket filter and require the real browser accessibility scan to pass without it before publication.

The first integrated browser run passed 21 journeys and exposed a member-visible invitation action outside the correctly filtered sidebar. A new component red test reproduced it. The greeting and provisioning actions now respect the existing management-role boundary; this is presentation gating, not server authorization. The corrected full suite passes 1,006 unit tests across 103 files, static and production guards, and all 22 selected home/shell/reload Chromium journeys with unfiltered accessibility checks.

## Admitted card and query correction

Status: Independent review found additional defects; correction specified before code.

Successful empty tenant, subscription and invoice lists must resolve to explicit null, because the query library refuses undefined successful results. Preserve pending, successful absence and failure separately, including a real hook/QueryClient acceptance for each list. A successful no-tenant read must reach the intended empty screen; a failed read must retain a recoverable error.

Clipboard confirmation and success analytics require the actual write promise to resolve; missing, denied or failed clipboard access must remain recoverable without an unhandled rejection. Clear transient feedback and ignore obsolete completions on unmount. Subscription and support failures must render card-local error/retry states instead of permanent skeletons. Forbidden billing cards stay absent; retries remain explicit and bounded to the failed read.

Invitation resends retain the successfully handled IDs while admitting newly eligible IDs from later props. Scope that state to the current person and organisation. A rate-limited ID has an absolute retry deadline, a real decreasing seconds display and no early resend; other eligible failed or newly arrived IDs remain usable. Retry only current eligible targets and never reattempt successful IDs. No background resend or new server endpoint is admitted.

Before corrections, mounted probes must fail for successful-empty queries, premature clipboard success, rejected clipboard handling, card errors, new invitations after batch success and actual rate-limit eligibility. Preserve all original positive invitation behavior and the reviewed generation-scoped current-user loader. Re-run the complete unit/static/production suite and browser home/authentication journeys including real empty-list and refusal responses. A separate expert must review the resulting correction; the implementer does not self-approve it.

The correction also follows Core's existing `docs/api/AUTHZ.md` role matrix and `docs/domain/TENANT_STATE_MACHINE.md`, without changing those proposals or the wire enums. Only owners see the new-order action. Owners and administrators see invitation/resend/domain management; owners, administrators and the provisional billing role can see billing links/cards. Members cannot. Shared sidebar and route permission corrections remain a separate lane.

Only `ordered`, `provisioning` and `ready` describe initial setup. `upgrading`, `maintenance`, `suspended`, `decommissioning`, `deleted` and `failed` display their closed state with existing status/support navigation. Unknown or unavailable status is recoverable error; no state transition, fresh order action or initial-setup promise is inferred from those states. The previous broad not-active assumption is superseded for this screen.

Final review acceptance also refuses a summary with a missing or invalid tenant identifier instead of authorizing empty ordering, admits only own lifecycle-map keys, and binds copied feedback to both application code and URL. Three additional red tests reproduce those cases before their narrow corrections; this is not a general API response-validation framework.

A completed status response without a lifecycle value must also reach the unknown-state error; only the query library’s actual loading state selects the skeleton. A separate red completed-response test and a passing pending-query control precede this correction.

Correction qualification: all 1,044 unit tests across 105 files pass, as do types, lint, formatting and production simulation exclusion. All 34 selected Home, shell/login and reload Chromium journeys pass, including successful empty lists, refusal and malformed responses, real clipboard readback, denied clipboard access, role boundaries, retry deadlines and unfiltered accessibility checks. The inherited document-viewer unused-disable warning and build chunk-size warning remain; neither gate was weakened. No auth, shared UI, dependency, workflow or API schema changes are part of this child correction. The integration and API fixtures establish local browser behavior only, not backend or deployment readiness.

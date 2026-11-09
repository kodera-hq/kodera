// The polling rule of docs/specs/08-home.md §5: `status-summary` every 60 s
// while the tab is visible, `tenant status` every 10 s while the tenant is
// `provisioning` and not at all once it is `active`; nothing polls while the
// tab is hidden; three consecutive failures back off to 5 min.
//
// Pure functions of `document.hidden` and a failure count — no timers, no
// TanStack Query import — so the rule itself is unit-testable without
// mounting a query client. `src/features/home/queries.ts` wires each one in
// as a `refetchInterval` callback; "resume on focus" is TanStack Query's own
// `refetchOnWindowFocus`, turned on per-query there rather than reimplemented
// here (`src/app/providers.tsx` leaves it off by default).

const NORMAL_STATUS_SUMMARY_MS = 60_000
const NORMAL_TENANT_STATUS_MS = 10_000
const BACKED_OFF_MS = 5 * 60_000
const CONSECUTIVE_FAILURES_BEFORE_BACKOFF = 3

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

/** `GET /organisations/{organisation_id}/status-summary`. */
export function statusSummaryRefetchInterval(failureCount: number): number | false {
  if (tabHidden()) return false
  return failureCount >= CONSECUTIVE_FAILURES_BEFORE_BACKOFF
    ? BACKED_OFF_MS
    : NORMAL_STATUS_SUMMARY_MS
}

/** `GET /tenants/{tenant_id}/status`, enabled only while there is a tenant to
 * poll — see `shouldPollTenantStatus`, which gates whether this query runs
 * at all rather than just how often. */
export function tenantStatusRefetchInterval(failureCount: number): number | false {
  if (tabHidden()) return false
  return failureCount >= CONSECUTIVE_FAILURES_BEFORE_BACKOFF
    ? BACKED_OFF_MS
    : NORMAL_TENANT_STATUS_MS
}

/** "…while the tenant is `provisioning` and not at all once it is `active`":
 * the tenant-status query is enabled only for a tenant that exists and has
 * not yet reached `active` — Home reads the summary once it has, per §6's
 * own note ("Home reads the summary, the Applications screen owns the
 * detail"). */
export function shouldPollTenantStatus(tenantStatus: string | undefined): boolean {
  return tenantStatus !== undefined && tenantStatus !== 'active'
}

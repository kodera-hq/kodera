// The polling interval for `GET /tenants/{tenant_id}/status` (docs/specs/
// 02-status.md §5): 30 s while `active`, 10 s while `provisioning`, backing
// off to 2 min after three consecutive failures. "Never while the tab is
// hidden" is TanStack Query's own default (`refetchIntervalInBackground:
// false`) and needs nothing here; "resumes on focus" is the query's
// `refetchOnWindowFocus: 'always'`, set at the call site. This module is the
// one pure decision — how long to wait next — kept out of the hook so it can
// be tested without a `QueryClient` at all.

const ACTIVE_INTERVAL_MS = 30_000
const PROVISIONING_INTERVAL_MS = 10_000
const BACKOFF_INTERVAL_MS = 120_000
const BACKOFF_AFTER_FAILURES = 3

/**
 * `status` is the last successfully read tenant status, or `undefined`
 * before the first response — the 30 s default until the first read says
 * otherwise. `failureCount` is however many consecutive fetch attempts have
 * just failed; at three or more, the backoff interval wins for every nonterminal
 * last known status. A validated deleted status stops polling; stale data is not a reason to hammer a
 * Core API that is not currently answering.
 */
export function statusPollingIntervalMs(
  status: string | undefined,
  failureCount: number
): number | false {
  if (status === 'deleted') return false
  if (failureCount >= BACKOFF_AFTER_FAILURES) return BACKOFF_INTERVAL_MS
  return status === 'provisioning' || status === 'ordered' || status === 'ready'
    ? PROVISIONING_INTERVAL_MS
    : ACTIVE_INTERVAL_MS
}

import { helpHref } from '../support/helpHref'

// Where "Nous écrire" / "Ouvrir un ticket" send the buyer: the Support area
// (`06-support.md`, a sibling unit's own scope — this unit only links to
// it), registered as `/{org}/help` (`src/features/support/routes.tsx`,
// "Aide" in the sidebar) with the context a ticket form would want
// pre-filled, carried as a query string. `reason` matches the
// `status_support_from_status` analytics property (§11) so the two stay in
// step; `jobId` is what a failed provisioning step's ticket needs (§12
// acceptance test 6).

export type SupportReason = 'stale' | 'step-failed' | 'late' | 'incident'

export function supportHref(org: string, reason: SupportReason, jobId?: string): string {
  return helpHref(org, jobId === undefined ? { reason } : { reason, job_id: jobId })
}

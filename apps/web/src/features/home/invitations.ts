// Pure logic for the pending-invitations banner (docs/specs/08-home.md §4.3,
// §6, §8): which invitations the banner is about, and how a batch of
// per-invitation resends turns into the partial-failure surface the state
// matrix describes. No React, no fetch — `HomeDefault.tsx` is the only
// caller, and this is what its tests exercise directly.

import type { components } from '../../api/schema'

type Invitation = components['schemas']['Invitation']

/** The life of the account set-up link the realm mails with an invitation: Core's
 * `ACTIONS_LIFESPAN_S` (apps/outbox/realm_accounts.py). A resend mails a fresh one. */
const SET_UP_LINK_MS = 72 * 60 * 60 * 1000

/**
 * "at least one invitation is `pending` and was last sent more than 72 hours
 * ago — 72 hours being the life of the account set-up link" (§4.3). A resend
 * moves `last_sent_at` and mails a fresh link, so the clock starts again; an
 * invitation never resent counts from `created_at`.
 * `now` is a parameter, not `Date.now()`, so the boundary itself is testable
 * without faking the system clock.
 */
export function invitationsPastTheirSetUpLink(
  invitations: readonly Invitation[],
  now: Date
): Invitation[] {
  const cutoff = now.getTime() - SET_UP_LINK_MS
  return invitations.filter(
    (invitation) => new Date(invitation.last_sent_at ?? invitation.created_at).getTime() < cutoff
  )
}

export interface ResendOutcome {
  invitation: Invitation
  ok: boolean
  /** Present only when `ok` is false and the failure was a rate limit
   * (§9: `actions/resend` → 429, "Per-address, with the countdown from
   * `retry_after_s`"). */
  retryAfterS?: number | undefined
}

export interface ResendSummary {
  attempted: number
  succeeded: number
  /** The invitations still pending after this batch — the partial-failure
   * subset a scoped retry targets (specs/README §2: "the successes are…
   * not re-attempted on retry; the failures are listed by row… retry is
   * scoped to the failed subset"). */
  failed: ResendOutcome[]
}

export function summariseResend(outcomes: readonly ResendOutcome[]): ResendSummary {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  return {
    attempted: outcomes.length,
    succeeded: outcomes.length - failed.length,
    failed,
  }
}

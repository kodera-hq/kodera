// docs/specs/08-home.md §7: four invitations that outlived their 72-hour
// set-up link, still inside their 14 days. Composes over `home.default` for a healthy baseline —
// list it first (`useScenario(page, ['home.default', 'home.pending-
// invitations'])`), since the later overlay wins on the shared invitations
// route.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'
import { problem } from '../problem'

const BASE = '*/api/v1'

type Invitation = components['schemas']['Invitation']

const DAY_MS = 24 * 60 * 60 * 1000
const FOUR_DAYS_AGO = new Date(Date.now() - 4 * DAY_MS).toISOString()
// Issued four days ago, so pending for ten more: Core lists no pending invitation past its 14 days.
const IN_TEN_DAYS = new Date(Date.now() + 10 * DAY_MS).toISOString()

/** When each invitation was last resent in this page's life, as Core moves `last_sent_at` on a
 * resend: the banner then counts from that send (§4.3). */
const resentAt = new Map<string, string>()

/** Forgets every resend: for a test that resends, so the next one starts from the seed. */
export function forgetResends(): void {
  resentAt.clear()
}

/** Records a successful resend, so the list answers the invitation as Core would after it. */
export function recordResend(id: string): Invitation | undefined {
  resentAt.set(id, new Date().toISOString())
  return pendingInvitations().find((invitation) => invitation.id === id)
}

/** `Invitation.id` is a UUID in the contract; the last digit is the invitation's index, so a
 * scenario composed over this one can name a single invitation. */
export function pendingInvitationId(index: number): string {
  return `4a6e2c1d-9b3f-4c7a-8e5d-00000000000${index}`
}

export function pendingInvitations(): Invitation[] {
  const names = ['marc', 'julie', 'paul', 'anne']
  return names.map((name, index) => ({
    id: pendingInvitationId(index),
    organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
    email: `${name}@acme.fr`,
    role: 'org_member',
    state: 'pending',
    expires_at: IN_TEN_DAYS,
    accepted_at: null,
    membership_id: null,
    sent_count: resentAt.has(pendingInvitationId(index)) ? 2 : 1,
    last_sent_at: resentAt.get(pendingInvitationId(index)) ?? FOUR_DAYS_AGO,
    created_at: FOUR_DAYS_AGO,
  }))
}

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/invitations`, () =>
    HttpResponse.json(
      { data: pendingInvitations(), next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listInvitations.headers } }
    )
  ),
  http.post(`${BASE}/invitations/:invitation_id/actions/resend`, ({ params }) => {
    const resent = recordResend(params['invitation_id'] as string)
    return resent === undefined
      ? problem('https://kodera.io/problems/not-found')
      : HttpResponse.json(resent, {
          status: 200,
          headers: { ...EXAMPLES.resendInvitation.headers },
        })
  }),
]

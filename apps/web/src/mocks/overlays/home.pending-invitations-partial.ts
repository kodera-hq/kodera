// docs/specs/08-home.md §7: the same four invitations as `home.pending-
// invitations`, but the second one's resend is rate limited — the
// partial-failure surface §4.3 and §9 describe. Compose in this order:
// `useScenario(page, ['home.default', 'home.pending-invitations-partial'])`
// (the last one already carries the four invitations, so `home.pending-
// invitations` itself is not needed in the list).

import { http, HttpResponse } from 'msw'
import { EXAMPLES } from '../generated/examples'
import { problem } from '../problem'
import { pendingInvitationId, pendingInvitations, recordResend } from './home.pending-invitations'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/invitations`, () =>
    HttpResponse.json(
      { data: pendingInvitations(), next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listInvitations.headers } }
    )
  ),
  http.post(`${BASE}/invitations/:invitation_id/actions/resend`, ({ params }) => {
    if (params['invitation_id'] === pendingInvitationId(1)) {
      return problem('https://kodera.io/problems/rate-limited', { retryAfterS: 30 })
    }
    const resent = recordResend(params['invitation_id'] as string)
    if (resent === undefined) return problem('https://kodera.io/problems/not-found')
    return HttpResponse.json(resent, {
      status: 200,
      headers: { ...EXAMPLES.resendInvitation.headers },
    })
  }),
]

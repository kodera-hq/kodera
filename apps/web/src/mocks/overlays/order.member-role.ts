// 01-order.md §7: "Caller has `role: member`; ordering is refused with
// `forbidden`." `GET /me` names the caller's own role in the organisation
// they belong to — `PlanStep` reads it from the org route's loader, not from
// this overlay directly, but a caller trying to order anyway is refused the
// same way.

import { http, HttpResponse } from 'msw/http'
import { ownedOrderMe } from '../orderIdentity'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/me`, () => {
    const me = ownedOrderMe()
    return HttpResponse.json({
      ...me,
      organisations: me.organisations.map((entry) => ({ ...entry, role: 'org_member' })),
    })
  }),
  http.post(`${BASE}/organisations/:organisation_id/orders`, () =>
    problem('https://kodera.io/problems/forbidden', {
      detail: 'A member cannot place an order.',
    })
  ),
]

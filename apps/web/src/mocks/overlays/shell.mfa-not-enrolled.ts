// docs/specs/00-shell-and-login.md §7: `/me` returns
// `identities[0].mfa_enrolled: false` — an authenticated admin who has not
// enrolled a second factor, forced to `mfa-enrol` before any other screen
// (acceptance test 4).

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/me`, ({ request }) => {
    const example = EXAMPLES.getMe
    const body = bindCurrentUserToMockRequest(example.body as components['schemas']['Me'], request)
    return HttpResponse.json(
      {
        ...body,
        identities: body.identities.map((identity) => ({ ...identity, mfa_enrolled: false })),
      },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

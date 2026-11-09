// docs/specs/00-shell-and-login.md §7: `/me` returns `staff: true` with
// `staff_roles: ["staff:support"]` and no `organisations[]`.
//
// The spec's own prose spells the role `staff:support`; the contract's
// closed enum (`components["schemas"]["Me"]["staff_roles"]`) spells it
// `staff_support` — an underscore, not a colon, and confirmed against
// `src/api/schema.d.ts`. This overlay uses the real enum member rather than
// the string the prose happens to use, since only the former is a value the
// generated types (and a real Core API) would ever actually send.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/me`, ({ request }) => {
    const example = EXAMPLES.getMe
    const body = bindCurrentUserToMockRequest(example.body as components['schemas']['Me'], request)
    return HttpResponse.json(
      { ...body, staff: true, staff_roles: ['staff_support'], organisations: [] },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

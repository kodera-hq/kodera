// §7: "Caller is `member`; the area is not reachable." The role check itself
// is client-side, off `GET /me`'s own `role` (`src/features/invoices/
// permissions.ts`) — no invoices endpoint needs overriding, only the role
// that gate reads.

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
      {
        ...body,
        organisations: body.organisations.map((entry) => ({ ...entry, role: 'org_member' })),
      },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

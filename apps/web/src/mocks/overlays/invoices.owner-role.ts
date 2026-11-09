// Explicit synthetic owner authority for payment-capable invoice journeys.

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
        organisations: body.organisations.map((entry) => ({ ...entry, role: 'org_owner' })),
      },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

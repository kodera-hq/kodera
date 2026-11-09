import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

type Me = components['schemas']['Me']

export const handlers = [
  http.get(`${BASE}/me`, ({ request }) => {
    const base = bindCurrentUserToMockRequest(EXAMPLES.getMe.body as Me, request)
    const body: Me = {
      ...base,
      organisations: base.organisations.map((entry) => ({ ...entry, role: 'org_billing' })),
    }
    return HttpResponse.json(body, { status: 200, headers: { ...EXAMPLES.getMe.headers } })
  }),
]

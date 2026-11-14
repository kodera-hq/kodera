// docs/specs/00-shell-and-login.md §7: `/me` returns exactly one entry in
// `organisations[]`, so the shell's organisation switcher renders as static
// text rather than a menu. The generated `getMe` example already carries one,
// but this overlay names the scenario explicitly rather than leaning on that:
// the base example is free to change shape under a future regeneration, and a
// test that means "single organisation" should not depend on that staying
// true by accident.

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
      { ...body, organisations: body.organisations.slice(0, 1) },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

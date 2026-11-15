import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'
let meReads = 0

export const handlers = [
  http.get(`${BASE}/me`, ({ request }) => {
    const example = EXAMPLES.getMe
    const body = bindCurrentUserToMockRequest(example.body as components['schemas']['Me'], request)
    meReads += 1

    if (meReads === 1) {
      const membership = body.organisations[0]!
      const identity = body.identities.find((candidate) => candidate.id === membership.identity_id)!

      // Break only the order entry's fresh authority read; subsequent shell
      // data stays valid so this mismatch reaches the route's secure refusal.
      identity.subject = `${identity.subject}:identity-mismatch`
    }

    return HttpResponse.json(body, {
      status: example.status,
      headers: { ...example.headers },
    })
  }),
]

// docs/specs/09-owner-claim.md §5: the invitation's claim has expired; the bootstrap read says so
// and nothing may be confirmed. Name it after `claim.issued` in `useScenario` so it wins.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/bootstrap', () => {
    const body = structuredClone(
      EXAMPLES.getOrganisationBootstrap.body
    ) as components['schemas']['OrganisationBootstrap']
    body.claim.state = 'expired'
    return HttpResponse.json(body, { headers: { 'X-Request-Id': crypto.randomUUID() } })
  }),
]

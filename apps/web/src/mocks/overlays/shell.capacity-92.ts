// docs/specs/00-shell-and-login.md §7: `status-summary` returns
// `capacity.participants.pct: 92` and `upgrade_prompt: true`.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => {
    const example = EXAMPLES.getOrganisationStatusSummary
    const body = example.body as components['schemas']['OrganisationStatusSummary']
    return HttpResponse.json(
      {
        ...body,
        overall: 'operational',
        components: body.components.map((component) => ({ ...component, state: 'operational' })),
        open_incident_ids: [],
        capacity: {
          seats: { used: 40, included: 100, pct: 40 },
          participants: { used: 92, included: 100, pct: 92 },
          storage: { used: 12, included: 100, pct: 12 },
          threshold_pct: 90,
          upgrade_prompt: true,
          suggested_capacity_tier_code: 'business-plus',
          measured_at: '2026-12-03T11:19:42Z',
        },
      },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

// docs/specs/08-home.md §7: calls degraded, one open incident — the health
// line reads "incident en cours" and the shell banner carries it. Compose
// over `home.default` for everything else.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => {
    const base = EXAMPLES.getOrganisationStatusSummary.body as OrganisationStatusSummary
    const body: OrganisationStatusSummary = {
      ...base,
      overall: 'degraded',
      components: [
        {
          id: '0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f',
          scope: 'tenant',
          tenant_id: base.tenant_id ?? null,
          key: 'calls',
          name: 'Calls',
          state: 'degraded',
          since: '2026-12-03T10:58:00Z',
          message_key: 'status.calls.degraded',
          incident_ref: 'INC-2026-014',
        },
      ],
      capacity: {
        seats: { used: 118, included: 150, pct: 78.7 },
        participants: { used: 62, included: 100, pct: 62 },
        storage: { used: 429496729600, included: 536870912000, pct: 80 },
        threshold_pct: 90,
        upgrade_prompt: false,
        suggested_capacity_tier_code: null,
        measured_at: '2026-12-03T11:19:42Z',
      },
      billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
      maintenance: null,
      open_incident_ids: ['3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e'],
    }
    return HttpResponse.json(body, {
      status: 200,
      headers: { ...EXAMPLES.getOrganisationStatusSummary.headers },
    })
  }),
]

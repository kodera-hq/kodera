// docs/specs/08-home.md §7: capacity at 100 % — the red, "Limite atteinte"
// state, both offer links. Compose over `home.default`.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => {
    const base = EXAMPLES.getOrganisationStatusSummary.body as OrganisationStatusSummary
    const body: OrganisationStatusSummary = {
      ...base,
      overall: 'operational',
      components: base.components.map((component) => ({ ...component, state: 'operational' })),
      capacity: {
        seats: { used: 150, included: 150, pct: 100 },
        participants: { used: 100, included: 100, pct: 100 },
        storage: { used: 429496729600, included: 536870912000, pct: 80 },
        threshold_pct: 90,
        upgrade_prompt: true,
        suggested_capacity_tier_code: 'L',
        measured_at: '2026-12-03T11:47:00Z',
      },
      billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
      maintenance: null,
      open_incident_ids: [],
    }
    return HttpResponse.json(body, {
      status: 200,
      headers: { ...EXAMPLES.getOrganisationStatusSummary.headers },
    })
  }),
]

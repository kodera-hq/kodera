// docs/specs/08-home.md §7: `billing.dunning_state: past_due` with an
// overdue invoice and an amount due — the next-invoice card's overdue
// variant. Compose over `home.default`.

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
      overall: 'operational',
      components: base.components.map((component) => ({ ...component, state: 'operational' })),
      capacity: {
        seats: { used: 118, included: 150, pct: 78.7 },
        participants: { used: 62, included: 100, pct: 62 },
        storage: { used: 429496729600, included: 536870912000, pct: 80 },
        threshold_pct: 90,
        upgrade_prompt: false,
        suggested_capacity_tier_code: null,
        measured_at: '2026-12-03T11:19:42Z',
      },
      billing: {
        dunning_state: 'past_due',
        oldest_overdue_invoice_id: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70',
        amount_due: { amount_minor: 538560, currency: 'EUR' },
      },
      maintenance: null,
      open_incident_ids: [],
    }
    return HttpResponse.json(body, {
      status: 200,
      headers: { ...EXAMPLES.getOrganisationStatusSummary.headers },
    })
  }),
]

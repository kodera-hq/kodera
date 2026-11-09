// docs/specs/08-home.md §7 / §8: `status-summary.capacity: null` — the
// gauge card is hidden entirely, never a 0 % gauge. Compose over
// `home.default`.

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
      capacity: null,
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

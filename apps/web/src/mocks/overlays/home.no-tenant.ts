// docs/specs/08-home.md §7: an organisation with no tenant at all — the
// empty state, "Aucune instance pour l'instant" (§5's Empty cell).
// `status-summary.tenant_id: null` and the fallback tenants list (§6, "only
// when status-summary.tenant_id is null") answers no rows.

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
      tenant_id: null,
      overall: 'operational',
      components: [],
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
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(
      { data: [], next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listTenants.headers } }
    )
  ),
]

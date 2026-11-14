// docs/specs/08-home.md §7: the healthy Home dashboard. The base
// `getOrganisationStatusSummary` example is `degraded` with `capacity:
// null` (it exists to exercise the incident/empty branches elsewhere), so
// this overlay is what every other Home overlay that only needs a healthy
// baseline composes over — an active subscription, no pending invitation,
// `overall: operational`, and a capacity gauge at 62 %.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']
type Subscription = components['schemas']['Subscription']

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
      billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
      maintenance: null,
      open_incident_ids: [],
    }
    return HttpResponse.json(body, {
      status: EXAMPLES.getOrganisationStatusSummary.status,
      headers: { ...EXAMPLES.getOrganisationStatusSummary.headers },
    })
  }),
  http.get(`${BASE}/organisations/:organisation_id/subscriptions`, () => {
    const base = EXAMPLES.listSubscriptions.body as { data: Subscription[] }
    return HttpResponse.json(
      { data: base.data, next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listSubscriptions.headers } }
    )
  }),
  http.get(`${BASE}/organisations/:organisation_id/invitations`, () =>
    HttpResponse.json(
      { data: [], next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listInvitations.headers } }
    )
  ),
]

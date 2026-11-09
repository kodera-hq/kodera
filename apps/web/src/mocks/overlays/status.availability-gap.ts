// docs/specs/02-status.md §7: `availability` returns one day with
// `state: no_data`.

import { http, HttpResponse } from 'msw'
import { operationalComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

const DAYS = [
  {
    date: '2026-12-03',
    components: [
      { key: 'web' as const, state: 'operational' as const, degraded_minutes: 0, down_minutes: 0 },
      {
        key: 'calls' as const,
        state: 'operational' as const,
        degraded_minutes: 0,
        down_minutes: 0,
      },
      {
        key: 'console' as const,
        state: 'operational' as const,
        degraded_minutes: 0,
        down_minutes: 0,
      },
    ],
  },
  {
    // A day the agent could not report on at all — never rendered as an
    // outage (the same "absent rather than approximated" rule the four
    // documented contract gaps follow): the history table's own
    // "Données indisponibles" row.
    date: '2026-12-02',
    components: [
      { key: 'web' as const, state: 'no_data' as const, degraded_minutes: 0, down_minutes: 0 },
      { key: 'calls' as const, state: 'no_data' as const, degraded_minutes: 0, down_minutes: 0 },
      { key: 'console' as const, state: 'no_data' as const, degraded_minutes: 0, down_minutes: 0 },
    ],
  },
]

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(tenantStatusBody({ status: 'active', components: operationalComponents() }))
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: operationalComponents(), next_cursor: null, has_more: false })
  ),
  http.get(`${BASE}/tenants/:tenant_id/availability`, () =>
    HttpResponse.json({ data: DAYS, next_cursor: null, has_more: false })
  ),
]

// docs/specs/02-status.md §7: `components[].key: calls` in `degraded`,
// `status/incidents` returns one open incident with two updates. §12
// acceptance test 4.

import { http, HttpResponse } from 'msw/http'
import { degradedComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'
import type { components } from '@/api/schema'

type Incident = components['schemas']['Incident']

const BASE = '*/api/v1'

const INCIDENT: Incident = {
  id: '3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e',
  reference: 'INC-2026-014',
  scope: 'tenant',
  tenant_id: '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  state: 'open',
  severity: 'major',
  component_keys: ['calls'],
  title_key: 'incident.calls.degraded',
  impact_key: 'incident.impact.calls_drop',
  started_at: '2026-12-03T10:58:00Z',
  resolved_at: null,
  next_update_at: '2026-12-03T12:00:00Z',
  updates: [
    { at: '2026-12-03T11:05:00Z', body_key: 'incident.update.investigating' },
    { at: '2026-12-03T11:20:00Z', body_key: 'incident.update.fixing' },
  ],
}

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(tenantStatusBody({ status: 'active', components: degradedComponents() }))
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: degradedComponents(), next_cursor: null, has_more: false })
  ),
  http.get(`${BASE}/status/incidents`, () =>
    HttpResponse.json({ data: [INCIDENT], next_cursor: null, has_more: false })
  ),
]

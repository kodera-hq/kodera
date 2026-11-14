// docs/specs/02-status.md §7: `status/components` returns `503` while
// `tenants/{id}/status` succeeds. §12 acceptance test 7.

import { http, HttpResponse } from 'msw/http'
import { problem } from '../problem'
import { operationalComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(tenantStatusBody({ status: 'active', components: operationalComponents() }))
  ),
  http.get(`${BASE}/status/components`, () =>
    problem('https://kodera.io/problems/service-unavailable', { retryAfterS: 30 })
  ),
]

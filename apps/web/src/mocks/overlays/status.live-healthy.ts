// docs/specs/02-status.md §7: `status: active`, three components
// operational, `capacity.participants.pct: 34`. §12 acceptance test 2.

import { http, HttpResponse } from 'msw'
import { operationalComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(
      tenantStatusBody({
        status: 'active',
        components: operationalComponents(),
        capacity: { participants: { used: 17, included: 50, pct: 34 } },
      })
    )
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: operationalComponents(), next_cursor: null, has_more: false })
  ),
]

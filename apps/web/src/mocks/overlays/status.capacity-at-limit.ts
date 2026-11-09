// docs/specs/02-status.md §7: `capacity.participants.pct: 100`; joins
// refused message.

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
        capacity: {
          participants: { used: 50, included: 50, pct: 100 },
          threshold_pct: 90,
          upgrade_prompt: true,
          suggested_capacity_tier_code: 'L',
        },
      })
    )
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: operationalComponents(), next_cursor: null, has_more: false })
  ),
]

// docs/specs/02-status.md §7: `apps[].custom_domain: null`; both addresses
// are the `kodera.io` ones.

import { http, HttpResponse } from 'msw'
import {
  fallbackOnlyApps,
  operationalComponents,
  tenantsListBody,
  tenantStatusBody,
} from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(
      tenantStatusBody({
        status: 'active',
        apps: fallbackOnlyApps(),
        components: operationalComponents(),
      })
    )
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: operationalComponents(), next_cursor: null, has_more: false })
  ),
]

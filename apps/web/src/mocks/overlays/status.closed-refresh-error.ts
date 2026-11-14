// Synthetic last-known maintenance observation followed by failed refreshes.
import { http, HttpResponse } from 'msw/http'
import { tenantStatusBody, tenantsListBody } from './support/status-fixtures'
let reads = 0
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json(tenantsListBody('maintenance'))
  ),
  http.get('*/api/v1/tenants/:tenant_id/status', () => {
    reads += 1
    return reads === 1
      ? HttpResponse.json(tenantStatusBody({ status: 'maintenance' }))
      : HttpResponse.json(
          {
            type: 'https://kodera.io/problems/service-unavailable',
            status: 503,
            title: 'Synthetic unavailable',
          },
          { status: 503 }
        )
  }),
]

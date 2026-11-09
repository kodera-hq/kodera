// Synthetic lifecycle acceptance.
import { http, HttpResponse } from 'msw'
import { tenantsListBody, tenantStatusBody } from './support/status-fixtures'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json(tenantsListBody('upgrading'))
  ),
  http.get('*/api/v1/tenants/:tenant_id/status', () =>
    HttpResponse.json(tenantStatusBody({ status: 'upgrading', provisioning_steps: [] }))
  ),
]

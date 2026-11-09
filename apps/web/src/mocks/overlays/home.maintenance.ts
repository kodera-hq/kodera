import { http, HttpResponse } from 'msw'
import { EXAMPLES } from '../generated/examples'
export const handlers = [
  http.get('*/api/v1/tenants/:tenant_id/status', () =>
    HttpResponse.json({ ...EXAMPLES.getTenantStatus.body, status: 'maintenance' })
  ),
]

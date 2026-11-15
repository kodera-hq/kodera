import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'
export const handlers = [
  http.get('*/api/v1/tenants/:tenant_id/status', () =>
    HttpResponse.json({ ...EXAMPLES.getTenantStatus.body, status: 'maintenance' })
  ),
]

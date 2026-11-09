// Synthetic boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/tenants/:tenant_id/status', () => HttpResponse.json({}, { status: 200 })),
]

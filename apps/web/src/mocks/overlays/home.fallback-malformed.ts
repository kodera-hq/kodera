// Synthetic malformed successful response must not mean no tenant.
import { http, HttpResponse } from 'msw/http'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () => HttpResponse.json({})),
]

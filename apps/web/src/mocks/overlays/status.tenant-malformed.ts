// Synthetic boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json({}, { status: 200 })
  ),
]

// Synthetic response for home boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/subscriptions', () =>
    HttpResponse.json({ data: [], next_cursor: null, has_more: false }, { status: 200 })
  ),
  http.get('*/api/v1/organisations/:organisation_id/invoices', () =>
    HttpResponse.json({ data: [], next_cursor: null, has_more: false }, { status: 200 })
  ),
]

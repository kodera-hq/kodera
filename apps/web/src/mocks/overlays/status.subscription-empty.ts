// Synthetic boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/subscriptions', () =>
    HttpResponse.json({ data: [], next_cursor: null, has_more: false }, { status: 200 })
  ),
]

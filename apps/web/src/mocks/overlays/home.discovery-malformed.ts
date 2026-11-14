// Synthetic response for home discovery acceptance.
import { http, HttpResponse } from 'msw/http'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/status-summary', () => HttpResponse.json({})),
]

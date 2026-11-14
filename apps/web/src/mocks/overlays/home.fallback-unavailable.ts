// Synthetic response for home boundary acceptance.
import { http, HttpResponse } from 'msw/http'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json(
      {
        type: 'https://kodera.io/problems/service-unavailable',
        status: 503,
        title: 'Synthetic response',
      },
      { status: 503 }
    )
  ),
]

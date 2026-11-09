// Synthetic boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json(
      {
        type: 'https://kodera.io/problems/service-unavailable',
        title: 'Synthetic unavailable',
        status: 503,
      },
      { status: 503 }
    )
  ),
]

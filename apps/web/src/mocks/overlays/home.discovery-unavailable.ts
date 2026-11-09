// Synthetic response for home boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/status-summary', () =>
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

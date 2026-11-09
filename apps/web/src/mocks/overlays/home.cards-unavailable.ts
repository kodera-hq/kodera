// Synthetic response for home boundary acceptance.
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/subscriptions', () =>
    HttpResponse.json(
      {
        type: 'https://kodera.io/problems/service-unavailable',
        status: 503,
        title: 'Synthetic response',
      },
      { status: 503 }
    )
  ),
  http.get('*/api/v1/organisations/:organisation_id/invoices', () =>
    HttpResponse.json(
      {
        type: 'https://kodera.io/problems/service-unavailable',
        status: 503,
        title: 'Synthetic response',
      },
      { status: 503 }
    )
  ),
  http.get('*/api/v1/support/help-context', () =>
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

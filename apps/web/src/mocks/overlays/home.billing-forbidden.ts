// Synthetic response for home boundary acceptance.
import { http } from 'msw/http'
import { problem } from '../problem'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/subscriptions', () =>
    problem('https://kodera.io/problems/forbidden')
  ),
  http.get('*/api/v1/organisations/:organisation_id/invoices', () =>
    problem('https://kodera.io/problems/forbidden')
  ),
]

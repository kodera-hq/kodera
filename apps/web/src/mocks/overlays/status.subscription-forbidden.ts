// Synthetic boundary acceptance.
import { http } from 'msw'
import { problem } from '../problem'
export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/subscriptions', () =>
    problem('https://kodera.io/problems/forbidden')
  ),
]

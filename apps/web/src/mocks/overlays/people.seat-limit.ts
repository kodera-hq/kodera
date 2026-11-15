// docs/specs/03-people.md §7 `people.seat-limit`: `POST /invitations` is
// refused because the seat limit is reached. The spec names the problem
// `capacity-exceeded`; the contract registry (v0.11.0) spells it
// `quota-exceeded`, which is what the API emits.

import { http } from 'msw/http'
import { problem } from '../problem'

export const handlers = [
  http.post('*/api/v1/organisations/:organisation_id/invitations', () =>
    problem('https://kodera.io/problems/quota-exceeded')
  ),
]

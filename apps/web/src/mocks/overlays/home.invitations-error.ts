// docs/specs/08-home.md §7: the invitations endpoint fails while every
// other call succeeds — the state matrix's "keeps the page usable when one
// call fails" case. Compose over `home.default`.

import { http } from 'msw'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/invitations`, () =>
    problem('https://kodera.io/problems/service-unavailable')
  ),
]

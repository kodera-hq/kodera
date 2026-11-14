// 01-order.md §7: "`legal-documents` returns one row whose `html_url`
// answers `502`" — the DPA's own body, in this console's implementation,
// never comes from `html_url` (ADR-0003 forbids a second backend call for
// it): it comes from `POST .../dpa`, generated per organisation. This
// overlay makes that generation fail instead, which is the same observable
// failure the acceptance test describes — "the DPA document body fails to
// render" — reached through the call this screen actually makes.

import { http } from 'msw/http'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/organisations/:organisation_id/dpa`, () =>
    problem('https://kodera.io/problems/internal-error', {
      detail: 'DPA generation failed for this fixture on purpose.',
    })
  ),
]

// docs/specs/00-shell-and-login.md §7: `auth/discover` returns `429` with
// `retry_after_s` — too many discovery attempts from this IP or for this
// submitted value.

import { http } from 'msw'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/auth/discover`, () =>
    problem('https://kodera.io/problems/rate-limited', { retryAfterS: 30 })
  ),
]

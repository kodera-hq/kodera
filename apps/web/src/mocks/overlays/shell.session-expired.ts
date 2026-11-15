// docs/specs/00-shell-and-login.md §7: every call returns `401` with `type`
// `.../unauthenticated`.

import { http } from 'msw/http'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const handlers = [
  http.all(`${BASE}/*`, () => problem('https://kodera.io/problems/unauthenticated')),
]

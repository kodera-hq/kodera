// docs/specs/00-shell-and-login.md §7: `auth/discover` answers `200` with
// `realm: null` and an empty `candidates[]` — the same shape an unknown slug
// gets (§6 Notes: "an unknown slug and an unknown domain give the same
// 200 ... not a 404"), so the console shows one neutral message regardless
// of which field was submitted.

import { http, HttpResponse } from 'msw'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/auth/discover`, () =>
    HttpResponse.json(
      {
        realm: null,
        issuer: null,
        openid_configuration_url: null,
        organisation: null,
        candidates: [],
      },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]

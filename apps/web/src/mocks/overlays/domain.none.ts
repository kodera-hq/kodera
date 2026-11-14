// docs/specs/04-domain.md §7: "`tenants/{id}/domains` returns an empty page;
// only `tenant.default_urls` exists". The instance itself stays the base
// example, which carries the provided addresses.

import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/tenants/:tenant_id/domains`, () =>
    HttpResponse.json(
      { data: [], next_cursor: null, has_more: false },
      { status: 200, headers: { ...EXAMPLES.listDomains.headers } }
    )
  ),
]

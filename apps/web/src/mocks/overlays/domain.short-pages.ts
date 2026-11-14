// docs/specs/domain-addresses-list.md: the six addresses of
// `domain.mixed-addresses`, served two at a time whatever `limit` asks for —
// "the server may return fewer items than asked; trust `has_more`" is the
// contract's own sentence about `limit`. Three pages, so a list that stopped
// at the first would show a third of the addresses and say nothing.

import { http, HttpResponse } from 'msw/http'
import { mixedAddresses, pageOf, pageRequest } from '../fixtures/domainFixtures'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const ROWS_PER_PAGE = 2

export const handlers = [
  http.get(`${BASE}/tenants/:tenant_id/domains`, ({ request }) => {
    const { cursor } = pageRequest(request.url)
    return HttpResponse.json(pageOf(mixedAddresses(), cursor, ROWS_PER_PAGE), {
      status: 200,
      headers: { ...EXAMPLES.listDomains.headers },
    })
  }),
]

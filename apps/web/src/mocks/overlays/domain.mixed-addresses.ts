// docs/specs/domain-addresses-list.md, "Scenario overlays": six addresses on
// one page, one of each kind the list has to tell apart — the main address,
// the address that carries its calls, one waiting for its proof, one proven
// and being finished, one that failed, and one with a very long name.

import { http, HttpResponse } from 'msw/http'
import { mixedAddresses, pageOf, pageRequest } from '../fixtures/domainFixtures'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/tenants/:tenant_id/domains`, ({ request }) => {
    const { cursor, limit } = pageRequest(request.url)
    return HttpResponse.json(pageOf(mixedAddresses(), cursor, limit), {
      status: 200,
      headers: { ...EXAMPLES.listDomains.headers },
    })
  }),
]

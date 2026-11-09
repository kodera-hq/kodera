// docs/specs/domain-addresses-list.md: the domain read answers
// `internal-error`, a failure the contract declares for this operation — so
// the overlay stays inside the contract and needs no exemption from
// `tests/unit/mocks/overlay-contract.test.ts`.
//
// The outage can END, because a retry that never succeeds proves only half of
// "explains a failed load and recovers on retry". Handlers run in the page, so
// the spec ends it by writing `sessionStorage['msw:domain-outage'] = 'over'` —
// the same store the scenario names themselves travel in — and from then on
// the read answers the mixed addresses. A counter ("fail three times, then
// succeed") would tie this file to the query client's retry count and turn a
// change of that number into a test that silently never sees the error.

import { http, HttpResponse } from 'msw'
import { mixedAddresses, pageOf, pageRequest } from '../fixtures/domainFixtures'
import { EXAMPLES } from '../generated/examples'
import { PROBLEM_TYPES } from '../generated/problems'
import { problem } from '../problem'

const BASE = '*/api/v1'

export const OUTAGE_KEY = 'msw:domain-outage'

// Looked up in the contract's registry rather than written out: the registry
// spells a problem type as a URI, and this area's files spell no address of
// ours (`tests/unit/domain/hosting-boundary.test.ts`).
const INTERNAL_ERROR = PROBLEM_TYPES.find((type) => type.endsWith('/internal-error'))

export const handlers = [
  http.get(`${BASE}/tenants/:tenant_id/domains`, ({ request }) => {
    if (window.sessionStorage.getItem(OUTAGE_KEY) !== 'over') {
      if (INTERNAL_ERROR === undefined) throw new Error('The contract lost `internal-error`.')
      return problem(INTERNAL_ERROR)
    }
    const { cursor, limit } = pageRequest(request.url)
    return HttpResponse.json(pageOf(mixedAddresses(), cursor, limit), {
      status: 200,
      headers: { ...EXAMPLES.listDomains.headers },
    })
  }),
]

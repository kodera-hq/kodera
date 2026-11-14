// docs/specs/09-owner-claim.md: an issued first-owner claim for the contract's organisation.
// The bootstrap read is the base handler's issued example. Consuming it makes the signed-in
// mock identity the organisation's `org_owner` in every later `/me`, as Core would; before it,
// that identity belongs to no organisation. The flag lives as long as the page.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'
import { ownedOrderMe } from '../orderIdentity'

const BASE = '*/api/v1'
let consumed = false

export const handlers = [
  http.get(`${BASE}/me`, () => {
    const me = ownedOrderMe()
    if (!consumed) me.organisations = []
    return HttpResponse.json(me, { headers: { 'X-Request-Id': crypto.randomUUID() } })
  }),
  http.post(`${BASE}/owner-claims/actions/consume`, () => {
    consumed = true
    const result = structuredClone(
      EXAMPLES.consumeOwnerClaim.body
    ) as components['schemas']['OwnerClaimResult']
    const identity = ownedOrderMe().identities[0]!
    result.membership.identity_id = identity.id
    return HttpResponse.json(result, { headers: { 'X-Request-Id': crypto.randomUUID() } })
  }),
]

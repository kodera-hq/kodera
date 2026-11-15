// 01-order.md §7: "An active subscription exists; the flow shows proration
// text and only larger capacity tiers." Names the scenario explicitly
// (rather than leaning on the generated `listSubscriptions` example staying
// this shape by accident): an active `visio-docs` subscription at tier `M`,
// the upgrade entry point's `from={currentPlan}` reads back.

import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/subscriptions`, () => {
    const example = EXAMPLES.listSubscriptions
    return HttpResponse.json(example.body, {
      status: example.status,
      headers: { ...example.headers, 'X-Request-Id': crypto.randomUUID() },
    })
  }),
]

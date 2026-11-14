// 01-order.md §7: "`OrderResult.tenant.status` is `ordered` and stays there
// through three polls." The confirmation copy must never promise
// provisioning has started (§6) — this overlay is what a Storybook state or
// a spec for the status screen uses to prove the tenant genuinely stays
// `ordered` across repeated reads, since the base example is free to change
// under a future regeneration.

import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/tenants/:tenant_id`, () => {
    const example = EXAMPLES.getTenant
    const body = example.body as Record<string, unknown>
    return HttpResponse.json(
      { ...body, status: 'ordered' },
      { headers: { ...example.headers, 'X-Request-Id': crypto.randomUUID() } }
    )
  }),
  http.get(`${BASE}/tenants/:tenant_id/status`, () => {
    const example = EXAMPLES.getTenantStatus
    const body = example.body as Record<string, unknown>
    return HttpResponse.json(
      { ...body, status: 'ordered' },
      { headers: { ...example.headers, 'X-Request-Id': crypto.randomUUID() } }
    )
  }),
]

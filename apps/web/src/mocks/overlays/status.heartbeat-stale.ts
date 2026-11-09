// docs/specs/02-status.md §7: `agent.stale: true`, `status` still `active`,
// components fall back to probes. §12 acceptance test 5.

import { http, HttpResponse } from 'msw'
import { operationalComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(
      tenantStatusBody({
        status: 'active',
        // "Components fall back to probe results" (§6's staleness note):
        // still operational readings, from probes rather than the agent's
        // own heartbeat, which is exactly what `agent.stale` alone signals.
        components: operationalComponents(),
        agent: { stale: true, last_heartbeat_at: '2026-12-03T09:40:00Z' },
      })
    )
  ),
  http.get(`${BASE}/status/components`, () =>
    HttpResponse.json({ data: operationalComponents(), next_cursor: null, has_more: false })
  ),
]

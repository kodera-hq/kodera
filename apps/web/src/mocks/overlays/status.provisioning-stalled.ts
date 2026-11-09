// docs/specs/02-status.md §7: the running step started well over its
// expected duration; `agent.stale: true`. The contract carries no
// `estimated_ready_at` or per-step expected-duration field (checked against
// `TenantStatusView` and `ProvisioningStep`), so `agent.stale` is the one
// measurable signal the screen has for "this is taking longer than
// expected" — this overlay is what exercises that reading.

import { http, HttpResponse } from 'msw'
import { sixStepsAt, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('provisioning'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(
      tenantStatusBody({
        status: 'provisioning',
        provisioning_steps: sixStepsAt(2),
        current_job: {
          job_id: 'a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f',
          kind: 'provision',
          status: 'running',
        },
        agent: { stale: true, last_heartbeat_at: '2026-12-02T20:00:00Z' },
      })
    )
  ),
]

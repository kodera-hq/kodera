// docs/specs/02-status.md §7: `tenants/{id}/status` returns
// `status: provisioning`, `provisioning_steps` with `apps` running and the
// two before it `succeeded`. §12 acceptance test 1.

import { http, HttpResponse } from 'msw/http'
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
      })
    )
  ),
]

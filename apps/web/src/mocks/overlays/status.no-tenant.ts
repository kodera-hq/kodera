// docs/specs/02-status.md §7: `organisations/{id}/tenants` returns an empty
// page while a subscription exists. §12 acceptance test 8. The base
// `listSubscriptions` example already carries one row, so nothing needs
// overriding there — only the tenants list changes.

import { http, HttpResponse } from 'msw'
import { emptyTenantsListBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(emptyTenantsListBody())
  ),
]

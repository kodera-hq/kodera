// docs/specs/00-shell-and-login.md §7: `status-summary` returns
// `overall: degraded` with `calls` degraded and an entry in
// `open_incident_ids[]` (acceptance test 8). Named explicitly rather than
// relying on the generated example already carrying this shape by
// coincidence — a future contract regeneration is free to change what the
// example looks like, and a test that means "calls is degraded" should not
// depend on that staying true by accident (the same reasoning
// `shell.single-organisation` gives for itself).

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => {
    const example = EXAMPLES.getOrganisationStatusSummary
    const body = example.body as components['schemas']['OrganisationStatusSummary']
    return HttpResponse.json(
      {
        ...body,
        overall: 'degraded',
        components: [
          {
            id: '0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f',
            scope: 'tenant',
            tenant_id: body.tenant_id,
            key: 'calls',
            name: 'Calls',
            state: 'degraded',
            since: '2026-12-03T10:58:00Z',
            message_key: 'status.calls.degraded',
            incident_ref: 'INC-2026-014',
          },
        ],
        open_incident_ids: ['3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e'],
      },
      { status: example.status, headers: { ...example.headers } }
    )
  }),
]

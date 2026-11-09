// docs/specs/08-home.md §7: a tenant mid-installation. `status-summary`
// carries the `tenant_id`, and `GET /tenants/{tenant_id}/status` answers
// `provisioning` with the six customer-facing steps, one of them running.
// Named to compose with a future `status.provisioning-in-progress` overlay
// (§7's own note), but self-contained today since that overlay does not
// exist yet — the status area unit had not landed when this one needed it.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

const BASE = '*/api/v1'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']
type TenantStatusView = components['schemas']['TenantStatusView']

const TENANT_ID = '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => {
    const base = EXAMPLES.getOrganisationStatusSummary.body as OrganisationStatusSummary
    const body: OrganisationStatusSummary = {
      ...base,
      tenant_id: TENANT_ID,
      overall: 'operational',
      components: [],
      capacity: null,
      billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
      maintenance: null,
      open_incident_ids: [],
    }
    return HttpResponse.json(body, {
      status: 200,
      headers: { ...EXAMPLES.getOrganisationStatusSummary.headers },
    })
  }),
  http.get(`${BASE}/tenants/:tenant_id/status`, () => {
    const base = EXAMPLES.getTenantStatus.body as TenantStatusView
    const body: TenantStatusView = {
      ...base,
      tenant_id: TENANT_ID,
      status: 'provisioning',
      provisioning_steps: [
        {
          key: 'preflight',
          customer_label_key: 'order',
          title: 'Order recorded',
          status: 'succeeded',
        },
        {
          key: 'host',
          customer_label_key: 'server',
          title: 'Server reserved',
          status: 'succeeded',
        },
        { key: 'deploy', customer_label_key: 'apps', title: 'Deploying apps', status: 'running' },
        { key: 'dns', customer_label_key: 'addresses', title: 'Addresses', status: 'pending' },
        { key: 'identity', customer_label_key: 'accounts', title: 'Accounts', status: 'pending' },
        { key: 'backup', customer_label_key: 'backups', title: 'Backups', status: 'pending' },
      ],
      apps: [],
      components: [],
    }
    return HttpResponse.json(body, {
      status: 200,
      headers: { ...EXAMPLES.getTenantStatus.headers },
    })
  }),
]

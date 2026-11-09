// docs/specs/02-status.md §7: one step in `status: failed` with a `job_id`,
// tenant `status: failed`. §12 acceptance test 6.

import { http, HttpResponse } from 'msw'
import { tenantsListBody, tenantStatusBody } from './support/status-fixtures'
import type { components } from '@/api/schema'

type ProvisioningStep = components['schemas']['ProvisioningStep']

const BASE = '*/api/v1'

const STEPS: ProvisioningStep[] = [
  {
    key: 'project',
    customer_label_key: 'order',
    title: 'Project bootstrap',
    status: 'succeeded',
    started_at: '2026-12-02T15:00:00Z',
    ended_at: '2026-12-02T15:05:00Z',
  },
  {
    key: 'host',
    customer_label_key: 'server',
    title: 'Host reserved',
    status: 'succeeded',
    started_at: '2026-12-02T15:05:00Z',
    ended_at: '2026-12-02T15:20:00Z',
  },
  {
    key: 'deploy',
    customer_label_key: 'apps',
    title: 'Deploy',
    status: 'failed',
    started_at: '2026-12-02T15:20:00Z',
    ended_at: '2026-12-02T15:35:00Z',
    job_id: '8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f',
    detail: 'Compose pull failed: registry timeout after 3 retries.',
  },
  { key: 'dns', customer_label_key: 'addresses', title: 'DNS and certificates', status: 'pending' },
  {
    key: 'identity',
    customer_label_key: 'accounts',
    title: 'Accounts and sign-in',
    status: 'pending',
  },
  {
    key: 'backup',
    customer_label_key: 'backups',
    title: 'Backups and monitoring',
    status: 'pending',
  },
]

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('failed'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () =>
    HttpResponse.json(
      tenantStatusBody({
        status: 'failed',
        provisioning_steps: STEPS,
        current_job: {
          job_id: '8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f',
          kind: 'provision',
          status: 'failed',
        },
      })
    )
  ),
]

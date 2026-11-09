// Shared fixture builders for the `status.*` scenario overlays. Not an
// overlay itself — lives one directory below `src/mocks/overlays/`, outside
// `index-glob.ts`'s own `./*.ts` pattern (which does not cross a directory
// boundary), so it is never mistaken for a scenario by file name.
//
// Every overlay in this unit answers the same three routes
// (`tenants/:tenant_id/status`, `organisations/:organisation_id/tenants`,
// `status/components`) with a small deviation from this baseline — a
// healthy, fully live tenant with six completed provisioning steps and two
// live applications — so each overlay file states only what makes its own
// scenario different, per `docs/dev/TESTING.md`'s "hand-writing a base
// response is how a mock drifts from the contract" (this is a scenario
// overlay, not a base response: it composes the same shapes the generated
// examples already carry, never invents a field the contract does not
// declare).

import type { components } from '@/api/schema'

type TenantStatusView = components['schemas']['TenantStatusView']
type ProvisioningStep = components['schemas']['ProvisioningStep']
type TenantApp = components['schemas']['TenantApp']
type StatusComponent = components['schemas']['StatusComponent']

export const TENANT_ID = '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
export const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'

const SIX_STEPS_DONE: ProvisioningStep[] = [
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
    status: 'succeeded',
    started_at: '2026-12-02T15:20:00Z',
    ended_at: '2026-12-02T15:50:00Z',
  },
  {
    key: 'dns',
    customer_label_key: 'addresses',
    title: 'DNS and certificates',
    status: 'succeeded',
    started_at: '2026-12-02T15:50:00Z',
    ended_at: '2026-12-02T15:58:00Z',
  },
  {
    key: 'identity',
    customer_label_key: 'accounts',
    title: 'Accounts and sign-in',
    status: 'succeeded',
    started_at: '2026-12-02T15:58:00Z',
    ended_at: '2026-12-02T16:03:00Z',
  },
  {
    key: 'backup',
    customer_label_key: 'backups',
    title: 'Backups and monitoring',
    status: 'succeeded',
    started_at: '2026-12-02T16:03:00Z',
    ended_at: '2026-12-02T16:04:00Z',
  },
]

export function sixStepsAt(runningIndex: number): ProvisioningStep[] {
  return SIX_STEPS_DONE.map((step, index) => {
    if (index < runningIndex) return step
    if (index === runningIndex) {
      const { ended_at: _ended, ...rest } = step
      return { ...rest, status: 'running' as const, ended_at: null }
    }
    const { started_at: _started, ended_at: _ended, ...rest } = step
    return { ...rest, status: 'pending' as const, started_at: null, ended_at: null }
  })
}

const LIVE_APPS: TenantApp[] = [
  {
    code: 'visio',
    name: 'Visio',
    url: 'https://visio.acme.fr',
    default_url: 'https://acme.visio.kodera.io',
    custom_domain: 'visio.acme.fr',
    state: 'live',
    version: '1.4',
  },
  {
    code: 'docs',
    name: 'Docs',
    url: 'https://docs.acme.fr',
    default_url: 'https://acme.docs.kodera.io',
    custom_domain: 'docs.acme.fr',
    state: 'live',
    version: '1.4',
  },
]

export function fallbackOnlyApps(): TenantApp[] {
  return LIVE_APPS.map((app) => ({
    ...app,
    url: app.default_url as string,
    custom_domain: null,
  }))
}

const OPERATIONAL_COMPONENTS: StatusComponent[] = [
  {
    id: '0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f',
    scope: 'platform',
    key: 'web',
    name: 'Web',
    state: 'operational',
    since: '2026-12-01T00:00:00Z',
  },
  {
    id: '1b2c3d4e-5f60-4718-9820-3b4c5d6e7f80',
    scope: 'platform',
    key: 'calls',
    name: 'Calls',
    state: 'operational',
    since: '2026-12-01T00:00:00Z',
  },
  {
    id: '2c3d4e5f-6071-4829-9031-4c5d6e7f8091',
    scope: 'platform',
    key: 'console',
    name: 'Console',
    state: 'operational',
    since: '2026-12-01T00:00:00Z',
  },
]

export function operationalComponents(): StatusComponent[] {
  return OPERATIONAL_COMPONENTS.map((component) => ({ ...component }))
}

export function degradedComponents(): StatusComponent[] {
  return [
    OPERATIONAL_COMPONENTS[0] as StatusComponent,
    {
      ...(OPERATIONAL_COMPONENTS[1] as StatusComponent),
      state: 'degraded',
      since: '2026-12-03T10:58:00Z',
      message_key: 'status.calls.degraded',
      incident_ref: 'INC-2026-014',
    },
    OPERATIONAL_COMPONENTS[2] as StatusComponent,
  ]
}

export interface StatusOverrides {
  status?: TenantStatusView['status']
  provisioning_steps?: ProvisioningStep[]
  apps?: TenantApp[]
  capacity?: Partial<TenantStatusView['capacity']>
  components?: StatusComponent[]
  agent?: Partial<TenantStatusView['agent']>
  current_job?: TenantStatusView['current_job']
}

export function tenantStatusBody(overrides: StatusOverrides = {}): TenantStatusView {
  return {
    tenant_id: TENANT_ID,
    status: overrides.status ?? 'active',
    status_changed_at: '2026-12-02T16:04:00Z',
    message_key: 'status.tenant.active',
    provisioning_steps: overrides.provisioning_steps ?? SIX_STEPS_DONE,
    current_job: overrides.current_job ?? null,
    apps: overrides.apps ?? LIVE_APPS,
    capacity: {
      seats: { used: 12, included: 150, pct: 8 },
      participants: { used: 17, included: 50, pct: 34 },
      storage: { used: 42_949_672_960, included: 536_870_912_000, pct: 8 },
      threshold_pct: 90,
      upgrade_prompt: false,
      suggested_capacity_tier_code: null,
      measured_at: '2026-12-03T11:19:42Z',
      ...overrides.capacity,
    },
    components: overrides.components ?? operationalComponents(),
    agent: {
      stale: false,
      last_heartbeat_at: '2026-12-03T11:19:42Z',
      agent_version: '0.4.2',
      maintenance: false,
      ...overrides.agent,
    },
    domains: [],
  }
}

export function tenantsListBody(status: TenantStatusView['status'] = 'active') {
  return {
    data: [
      {
        id: TENANT_ID,
        organisation_id: ORGANISATION_ID,
        slug: 'acme',
        name: 'ACME',
        status,
        status_changed_at: '2026-12-02T16:04:00Z',
        pack_code: 'visio-docs',
        capacity_tier_code: 'M',
        apps: ['visio', 'docs'],
        region: 'fr-par',
        created_at: '2026-12-01T09:41:07Z',
      },
    ],
    next_cursor: null,
    has_more: false,
  }
}

export function emptyTenantsListBody() {
  return { data: [], next_cursor: null, has_more: false }
}

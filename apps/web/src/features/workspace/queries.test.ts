import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { cachedTenantSlug, workspaceTenantQueryKey } from './queries'
import type { WorkspaceTenant } from './workspace'

describe("the tenant's slug the live workspace is checked against", () => {
  const client = () => new QueryClient()

  it('is the open tenant’s', () => {
    const queries = client()
    for (const status of ['active', 'upgrading', 'maintenance'] as const) {
      queries.setQueryData<WorkspaceTenant>(workspaceTenantQueryKey('org-1'), {
        slug: 'acme',
        status,
      })
      expect(cachedTenantSlug(queries, 'org-1')).toBe('acme')
    }
  })

  it.each([
    'ordered',
    'provisioning',
    'ready',
    'failed',
    'suspended',
    'decommissioning',
    'deleted',
  ] as const)('is none while the tenant is %s', (status) => {
    const queries = client()
    queries.setQueryData<WorkspaceTenant>(workspaceTenantQueryKey('org-1'), {
      slug: 'acme',
      status,
    })
    expect(cachedTenantSlug(queries, 'org-1')).toBeUndefined()
  })

  it('is none before the tenant is read, when there is none, and for another organisation', () => {
    const queries = client()
    expect(cachedTenantSlug(queries, 'org-1')).toBeUndefined()
    queries.setQueryData<WorkspaceTenant | null>(workspaceTenantQueryKey('org-1'), null)
    expect(cachedTenantSlug(queries, 'org-1')).toBeUndefined()
    queries.setQueryData<WorkspaceTenant>(workspaceTenantQueryKey('org-2'), {
      slug: 'other',
      status: 'active',
    })
    expect(cachedTenantSlug(queries, 'org-1')).toBeUndefined()
  })
})

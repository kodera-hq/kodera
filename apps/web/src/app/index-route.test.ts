// `/` sends a signed-in person to their first organisation: a member to Espace (the workspace)
// when the organisation has it or has no tenant yet; the others, and a member of an organisation
// whose tenant runs without it or whose applications cannot be read, Home.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerInteractiveDemo } from './interactiveDemo'
import { createLocalWorkspaceStore } from '../mocks/demo/workspaceStore'
import { queryClient } from './queryClient'

const h = vi.hoisted(() => ({
  role: 'org_member' as string,
  includeCommunity: false,
  tenant: { id: 'tenant-1' } as { id: string } | null,
  apps: ['visio', 'messaging'] as string[],
  status: 'ok' as 'ok' | 'down',
  tenantRead: 'ok' as 'ok' | 'down',
  restored: true,
  communityHost: false,
}))

vi.mock('./communityHost', () => ({ onCommunityHost: () => h.communityHost }))

vi.mock('../features/status/queries', () => ({
  fetchFirstTenant: () =>
    h.tenantRead === 'ok'
      ? Promise.resolve(h.tenant)
      : Promise.reject(new Error('Synthetic outage')),
  fetchTenantStatus: () =>
    h.status === 'ok'
      ? Promise.resolve({ apps: h.apps.map((code) => ({ code })) })
      : Promise.reject(new Error('Synthetic outage')),
}))

vi.mock('../auth/oidc', () => ({
  authAdapter: {
    restoreSession: () => Promise.resolve(h.restored),
    getSnapshot: () => ({ status: 'ready', generation: 1, credentialGeneration: 1 }),
    getAccessToken: () => 'synthetic-access',
  },
}))

vi.mock('./currentUser', () => ({
  loadCurrentUser: () =>
    Promise.resolve({
      me: {
        organisations: [
          { organisation: { id: 'org-1', slug: 'acme-sa' }, role: h.role },
          ...(h.includeCommunity
            ? [{ organisation: { id: 'community-id', slug: 'community' }, role: h.role }]
            : []),
        ],
      },
      generation: 1,
      credentialGeneration: 1,
    }),
}))

import { indexRoute } from './index-route'

async function landing(): Promise<unknown> {
  const guard = indexRoute.options.beforeLoad as () => Promise<unknown>
  try {
    await guard()
  } catch (redirect) {
    return (redirect as { options: unknown }).options
  }
  throw new Error('The index route did not redirect.')
}

describe('the index route', () => {
  beforeEach(() => {
    h.role = 'org_member'
    h.includeCommunity = false
    h.tenant = { id: 'tenant-1' }
    h.apps = ['visio', 'messaging']
    h.status = 'ok'
    h.tenantRead = 'ok'
    h.restored = true
    h.communityHost = false
    queryClient.clear()
  })

  afterEach(() => registerInteractiveDemo(undefined))

  it('prefers the community workspace in demo mode even when another membership is first', async () => {
    h.includeCommunity = true
    registerInteractiveDemo({
      slug: 'community',
      landing: '/$org/workspace',
      createStore: createLocalWorkspaceStore,
    })
    expect(await landing()).toMatchObject({ to: '/$org/workspace', params: { org: 'community' } })
  })

  it('sends a signed-out visitor of the community host to the community welcome', async () => {
    h.restored = false
    h.communityHost = true
    expect(await landing()).toMatchObject({ to: '/login', search: { org: 'community' } })
    h.communityHost = false
    expect(await landing()).toEqual(expect.not.objectContaining({ search: expect.anything() }))
  })

  it('prefers the community membership on the community host, whatever its base domain', async () => {
    h.includeCommunity = true
    h.communityHost = true
    expect(await landing()).toMatchObject({ to: '/$org/workspace', params: { org: 'community' } })
    h.communityHost = false
    expect(await landing()).toMatchObject({ to: '/$org/workspace', params: { org: 'acme-sa' } })
  })

  it('sends a member to Espace', async () => {
    expect(await landing()).toMatchObject({ to: '/$org/workspace', params: { org: 'acme-sa' } })
  })

  it('sends a member of a Visio-only organisation to Home, which lists its applications', async () => {
    h.apps = ['visio']
    expect(await landing()).toMatchObject({ to: '/$org/home', params: { org: 'acme-sa' } })
  })

  it('sends a member of an organisation with no tenant yet to the workspace, which says how setup stands', async () => {
    h.tenant = null
    expect(await landing()).toMatchObject({ to: '/$org/workspace', params: { org: 'acme-sa' } })
  })

  it('sends a member to Home when the status cannot be read', async () => {
    h.status = 'down'
    expect(await landing()).toMatchObject({ to: '/$org/home', params: { org: 'acme-sa' } })
  })

  it('sends a member to Home when the tenant list cannot be read, never to the no-tenant workspace', async () => {
    h.tenantRead = 'down'
    expect(await landing()).toMatchObject({ to: '/$org/home', params: { org: 'acme-sa' } })
  })

  it.each(['org_owner', 'org_admin', 'org_billing'])(
    'sends %s to Home before a tenant exists',
    async (role) => {
      h.role = role
      h.tenant = null
      expect(await landing()).toMatchObject({ to: '/$org/home', params: { org: 'acme-sa' } })
    }
  )

  it.each(['org_owner', 'org_admin', 'org_billing'])('sends %s to Home', async (role) => {
    h.role = role
    expect(await landing()).toMatchObject({ to: '/$org/home', params: { org: 'acme-sa' } })
  })
})

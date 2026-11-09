import { expect, it, vi } from 'vitest'
import type * as IdentitySdk from 'oidc-client-ts'

const { silent, get } = vi.hoisted(() => ({ silent: vi.fn(), get: vi.fn() }))
vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof IdentitySdk>()
  return {
    ...actual,
    UserManager: class {
      events = {
        addAccessTokenExpired: vi.fn(),
        addAccessTokenExpiring: vi.fn(),
        addUserLoaded: vi.fn(),
        removeAccessTokenExpired: vi.fn(),
        removeAccessTokenExpiring: vi.fn(),
        removeUserLoaded: vi.fn(),
      }
      signinSilent = silent
      stopSilentRenew = vi.fn()
      removeUser = vi.fn(async () => {})
    },
  }
})
vi.mock('../api/client', () => ({ coreApi: () => ({ GET: get }), setTokenProvider: vi.fn() }))
import { authAdapter } from '../auth/oidc'
import { indexRoute } from './index-route'
import { orgRoute } from './org-route'
import { queryClient } from './queryClient'

it('concurrent index and organisation guards share restoration and one fresh identity fetch', async () => {
  import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
  import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'
  sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
  queryClient.setQueryData(['me'], { id: 'stale-person' })
  let finishAuth!: (user: unknown) => void
  let finishMe!: (value: unknown) => void
  silent.mockReturnValue(
    new Promise((resolve) => {
      finishAuth = resolve
    })
  )
  get.mockReturnValue(
    new Promise((resolve) => {
      finishMe = resolve
    })
  )
  const indexGuard = indexRoute.options.beforeLoad as () => Promise<unknown>
  const organisationGuard = orgRoute.options.beforeLoad as (args: {
    params: { org: string }
    location: { href: string }
    matches: Array<{ routeId: string; status: string; cause: 'enter' | 'stay' }>
    routeId: string
    cause: 'enter' | 'stay'
  }) => Promise<unknown>
  const organisationLoader = orgRoute.options.loader as (args: {
    params: { org: string }
    context: { holdExpiredRoute: boolean }
    abortController: AbortController
  }) => Promise<unknown>
  const index = indexGuard().catch((redirect: unknown) => redirect)
  const organisation = organisationGuard({
    params: { org: 'acme-sa' },
    location: { href: '/acme-sa/home' },
    matches: [{ routeId: orgRoute.id, status: 'pending', cause: 'enter' }],
    routeId: orgRoute.id,
    cause: 'enter',
  })
  expect(silent).toHaveBeenCalledTimes(1)
  expect(get).not.toHaveBeenCalled()
  finishAuth({
    access_token: 'synthetic',
    expired: false,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: { sub: 'synthetic' },
  })
  const context = (await organisation) as { holdExpiredRoute: boolean }
  const loaded = organisationLoader({
    params: { org: 'acme-sa' },
    context,
    abortController: new AbortController(),
  })
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  const me = {
    id: 'fresh-person',
    organisations: [{ organisation: { id: 'fresh-org', slug: 'acme-sa' } }],
  }
  finishMe({ data: me })
  expect(await loaded).toMatchObject({ me })
  await index
  expect(queryClient.getQueryData(['me'])).toBeUndefined()
  expect(get).toHaveBeenCalledTimes(1)
  await authAdapter.signOut()
  queryClient.clear()
})

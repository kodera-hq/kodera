import {
  createMemoryHistory,
  createRoute,
  createRouter,
  isNotFound,
  isRedirect,
  redirect,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as AuthModule from '../auth/oidc'
import type * as CommunityAccess from './communityAccess'
import type * as ApiClient from '../api/client'

const { discover, loadCurrentUser } = vi.hoisted(() => ({
  discover: vi.fn(),
  loadCurrentUser: vi.fn(),
}))
vi.mock('./currentUser', () => ({ loadCurrentUser }))
vi.mock('../api/mutations', () => ({ mutate: discover }))

let auth: typeof AuthModule.authAdapter
let hints: typeof CommunityAccess
let ApiProblem: typeof ApiClient.ApiProblem
let guard: (args: {
  params: { org: string }
  location: { href: string }
  matches: []
  routeId: string
  cause: 'enter'
  preload?: boolean
  abortController?: AbortController
}) => Promise<unknown>

beforeEach(async () => {
  vi.resetModules()
  sessionStorage.clear()
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  ;({ authAdapter: auth } = await import('../auth/oidc'))
  hints = await import('./communityAccess')
  ;({ ApiProblem } = await import('../api/client'))
  const { orgRoute } = await import('./org-route')
  guard = orgRoute.options.beforeLoad as unknown as typeof guard
  vi.spyOn(auth, 'restoreSession').mockResolvedValue(false)
  vi.spyOn(auth, 'signIn').mockResolvedValue()
  discover.mockReset()
  loadCurrentUser.mockReset()
})

afterEach(() => {
  hints.clearKnownSharedRealmSlugs()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sessionStorage.clear()
})

function enter(
  org: string,
  path = `/${org}/workspace`,
  options: { preload?: boolean; abortController?: AbortController } = {}
) {
  return guard({
    params: { org },
    location: { href: path },
    matches: [],
    routeId: '/$org',
    cause: 'enter',
    ...options,
  })
}

async function expectLogin(org: string, withSearch = true) {
  const result: unknown = await enter(org).catch((error: unknown) => error)
  expect(isRedirect(result)).toBe(true)
  expect(result).toMatchObject({
    options: { to: '/login', ...(withSearch ? { search: { org } } : {}) },
  })
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe(`/${org}/workspace`)
}

it('revalidates a persisted shared-realm hint on cold reload, updates upgraded realms, and falls back to hint on 429', async () => {
  sessionStorage.setItem('kodera.web.auth.sharedRealmSlugs', '["testing"]')
  discover.mockResolvedValueOnce({
    realm: 'testing',
    organisation: { slug: 'testing', realm: 'testing' },
  })
  await enter('testing')
  expect(discover).toHaveBeenCalledOnce()
  expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('testing')
  expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)

  hints.rememberSharedRealmSlug('testing')
  discover.mockRejectedValueOnce(new ApiProblem({ type: null, status: 429, title: 'Rate limited' }))
  await enter('testing')
  expect(auth.signIn).toHaveBeenLastCalledWith('community')
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/testing/workspace')
  await auth.signOut()
  expect(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')).toBeNull()
  expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
})

it('discovers the community realm on a cold shared workspace entry', async () => {
  discover.mockResolvedValue({
    realm: 'community',
    organisation: { slug: 'testing', realm: 'community' },
  })
  await enter('testing')
  expect(discover).toHaveBeenCalledExactlyOnceWith(
    { method: 'post', path: '/auth/discover' },
    { body: { slug: 'testing' } }
  )
  expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('community')
  expect(hints.isKnownSharedRealmSlug('testing')).toBe(true)
  expect(JSON.parse(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')!)).toContain(
    'testing'
  )
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/testing/workspace')
})

it('discovers the dedicated realm for a cold Sovereign entry', async () => {
  discover.mockResolvedValue({
    realm: 'acme-sa',
    organisation: { slug: 'acme-sa', realm: 'acme-sa' },
  })
  await enter('acme-sa', '/acme-sa/home')
  expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('acme-sa')
  expect(discover).toHaveBeenCalledExactlyOnceWith(
    { method: 'post', path: '/auth/discover' },
    { body: { slug: 'acme-sa' } }
  )
  expect(hints.isKnownSharedRealmSlug('acme-sa')).toBe(false)
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/home')
})

it('propagates sign-in errors without treating them as discovery refusals', async () => {
  discover.mockResolvedValue({
    realm: 'community',
    organisation: { slug: 'testing', realm: 'community' },
  })
  const error = new ApiProblem({ type: null, status: 422, title: 'Sign-in failed' })
  vi.mocked(auth.signIn).mockRejectedValue(error)
  await expect(enter('testing')).rejects.toBe(error)
})

it.each([
  null,
  undefined,
  42,
  'community',
  {},
  ...['a', 'a'.repeat(63), 'other-tenant', 'kodera-staff'].map((realm) => ({
    realm,
    organisation: { slug: 'unknown-org', realm },
  })),
  { realm: 'community', organisation: null },
  { realm: 'community' },
  { realm: 'community', organisation: { slug: 'unknown-org' } },
  { realm: null },
  { realm: '' },
  { realm: 'https://id.example.test' },
  { realm: 'community\n' },
  { realm: 'a'.repeat(64) },
  { realm: 'community', organisation: { slug: 'another', realm: 'community' } },
  { realm: 'community', organisation: { slug: 'unknown-org', realm: 'another' } },
])('rejects unknown or inconsistent discovery: %j', async (result) => {
  discover.mockResolvedValue(result)
  expect(isNotFound(await enter('unknown-org').catch((error) => error))).toBe(true)
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  expect(hints.isKnownSharedRealmSlug('unknown-org')).toBe(false)
})

it.each(['BAD-ORG', 'abcd', 'invalid.org', 'a'.repeat(21)])(
  'never discovers or signs in a malformed slug: %s',
  async (org) => {
    expect(isNotFound(await enter(org).catch((error) => error))).toBe(true)
    expect(auth.signIn).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
    expect(discover).not.toHaveBeenCalled()
  }
)

it.each([422, 429])('delegates discovery status %s to login', async (status) => {
  discover.mockRejectedValue(new ApiProblem({ type: null, status, title: 'Discovery refused' }))
  await expectLogin('unknown-org')
})

it.each([503])('propagates discovery status %s', async (status) => {
  const error = new ApiProblem({ type: null, status, title: 'Discovery failed' })
  discover.mockRejectedValue(error)
  await expect(enter('testing')).rejects.toBe(error)
  expect(auth.signIn).not.toHaveBeenCalled()
})

it('propagates transport errors and thrown router redirects unchanged', async () => {
  for (const error of [new TypeError('Failed to fetch'), redirect({ to: '/login' })]) {
    discover.mockRejectedValue(error)
    await expect(enter('testing')).rejects.toBe(error)
  }
  expect(auth.signIn).not.toHaveBeenCalled()
})

it('keeps community entry on the public login screen', async () => {
  await expectLogin('community')
  expect(discover).not.toHaveBeenCalled()
})

it('keeps mock mode free of discovery and uses remembered shared realms', async () => {
  vi.stubEnv('VITE_AUTH_MODE', 'mock')
  await enter('acme-sa')
  hints.rememberSharedRealmSlug('testing')
  await enter('testing')
  expect(auth.signIn).toHaveBeenNthCalledWith(1, 'acme-sa')
  expect(auth.signIn).toHaveBeenNthCalledWith(2, 'community')
  expect(discover).not.toHaveBeenCalled()
})

it('turns an unexpected discovery 401 into a generic error rather than session expiry', async () => {
  const fault = new ApiProblem({ type: null, status: 401, title: 'Discovery failed' })
  discover.mockRejectedValue(fault)
  const error = await enter('testing').catch((error) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({
    message: 'Realm discovery failed with unexpected 401.',
    cause: fault,
  })
  const { isUnauthenticated } = await import('./RouteError')
  expect(isUnauthenticated(error)).toBe(false)
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
})

it.each(['abort', 'sign-out'] as const)('fences discovery after %s', async (action) => {
  let resolve!: (value: unknown) => void
  discover.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const abortController = new AbortController()
  const request = enter('testing', '/testing/workspace', { abortController })
  const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())
  if (action === 'abort') abortController.abort()
  else await auth.signOut()
  resolve({ realm: 'community', organisation: { slug: 'testing', realm: 'community' } })
  await rejection
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  expect(hints.isKnownSharedRealmSlug('testing')).toBe(false)
  vi.resetModules()
  expect((await import('../auth/sharedRealmHints')).isKnownSharedRealmSlug('testing')).toBe(false)
})

it('aborts unauthenticated speculative preload cleanly without blocking subsequent navigation', async () => {
  await expect(enter('testing', '/testing/workspace', { preload: true })).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(discover).not.toHaveBeenCalled()
  expect(auth.restoreSession).not.toHaveBeenCalled()
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  expect(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')).toBeNull()

  discover.mockResolvedValueOnce({
    realm: 'community',
    organisation: { slug: 'testing', realm: 'community' },
  })
  const { orgRoute } = await import('./org-route')
  const { rootRoute } = await import('./root-route')
  const page = createRoute({ getParentRoute: () => orgRoute, path: 'workspace' })
  const home = createRoute({ getParentRoute: () => rootRoute, path: 'login' })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([page]), home]),
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  })
  await router.load()
  await router.preloadRoute({ to: '/$org/workspace', params: { org: 'testing' } }).catch(() => {})
  expect(discover).not.toHaveBeenCalled()
  void router.navigate({ to: '/$org/workspace', params: { org: 'testing' } })
  await vi.waitFor(() => expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('community'))
})

it('holds a router load after OIDC sign-in resolves without ever requesting /me', async () => {
  discover.mockResolvedValue({
    realm: 'community',
    organisation: { slug: 'testing', realm: 'community' },
  })
  const { orgRoute } = await import('./org-route')
  const { rootRoute } = await import('./root-route')
  const page = createRoute({ getParentRoute: () => orgRoute, path: 'workspace' })
  const login = createRoute({ getParentRoute: () => rootRoute, path: 'login' })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([page]), login]),
    history: createMemoryHistory({ initialEntries: ['/testing/workspace'] }),
  })
  let settled = false
  const loading = router.load().then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('community'))
  await vi.waitFor(() =>
    expect(
      router.state.matches.find((match) => match.routeId === orgRoute.id)?.context
    ).toMatchObject({ holdExpiredRoute: true })
  )
  expect(settled).toBe(false)
  expect(loadCurrentUser).not.toHaveBeenCalled()
  await router.navigate({ to: '/login' })
  await loading
})

it.each([false, true])(
  'self-heals a stale shared hint after upgrade (membership missing=%s)',
  async (missing) => {
    hints.rememberSharedRealmSlug('acme-sa')
    const snapshot = {
      ...auth.getSnapshot(),
      status: 'ready' as const,
      user: { realm: 'community' },
    }
    vi.spyOn(auth, 'getSnapshot').mockReturnValue(snapshot)
    vi.spyOn(auth, 'getAccessToken').mockReturnValue('credential')
    loadCurrentUser.mockResolvedValue({
      me: {
        organisations: missing
          ? []
          : [{ organisation: { slug: 'acme-sa', realm: 'acme-sa' }, shared_realm: false }],
      },
      generation: snapshot.generation,
      credentialGeneration: snapshot.credentialGeneration,
    })
    discover.mockResolvedValue({
      realm: 'acme-sa',
      organisation: { slug: 'acme-sa', realm: 'acme-sa' },
    })
    const { orgRoute } = await import('./org-route')
    const loader = orgRoute.options.loader as unknown as (args: {
      params: { org: string }
      location: { href: string }
      context: { holdExpiredRoute: boolean }
      abortController: AbortController
    }) => Promise<unknown>
    const abortController = new AbortController()
    const request = loader({
      params: { org: 'acme-sa' },
      location: { href: '/acme-sa/workspace' },
      context: { holdExpiredRoute: false },
      abortController,
    })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('acme-sa'))
    expect(hints.isKnownSharedRealmSlug('acme-sa')).toBe(false)
    expect(discover).toHaveBeenCalledTimes(missing ? 1 : 0)
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/workspace')
    abortController.abort()
    await rejection
  }
)

it('does not hold the route when in-process Desktop sign-in resolves with a covering token', async () => {
  discover.mockResolvedValueOnce({
    realm: 'community',
    organisation: { slug: 'testing', realm: 'community' },
  })
  vi.mocked(auth.signIn).mockImplementationOnce(async () => {
    vi.spyOn(auth, 'getAccessToken').mockReturnValue('desktop-token')
    vi.spyOn(auth, 'getUser').mockReturnValue({ realm: 'community' })
  })
  await expect(enter('testing')).resolves.toEqual({ holdExpiredRoute: false })
})

it('aborts an authenticated speculative preload when /me reveals an upgraded workspace without starting sign-in', async () => {
  hints.rememberSharedRealmSlug('acme-sa')
  const snapshot = {
    ...auth.getSnapshot(),
    status: 'ready' as const,
    user: { realm: 'community' },
  }
  vi.spyOn(auth, 'getSnapshot').mockReturnValue(snapshot)
  vi.spyOn(auth, 'getAccessToken').mockReturnValue('credential')
  loadCurrentUser.mockResolvedValue({
    me: { organisations: [] },
    generation: snapshot.generation,
    credentialGeneration: snapshot.credentialGeneration,
  })
  const { orgRoute } = await import('./org-route')
  const loader = orgRoute.options.loader as unknown as (args: {
    params: { org: string }
    location: { href: string }
    context: { holdExpiredRoute: boolean }
    preload: boolean
    abortController: AbortController
  }) => Promise<unknown>
  await expect(
    loader({
      params: { org: 'acme-sa' },
      location: { href: '/acme-sa/workspace' },
      context: { holdExpiredRoute: false },
      preload: true,
      abortController: new AbortController(),
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(discover).not.toHaveBeenCalled()
  expect(auth.signIn).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  expect(hints.isKnownSharedRealmSlug('acme-sa')).toBe(true)
})

// The application's own router (`createAppRouter`) with the real route units: what is in its
// route table before anyone goes anywhere, what one address adds to it, and that an area's
// routes never appear there before the area's message namespace has arrived. The mechanism is
// tested against units it controls in `./lazyRouteTree.test.tsx`; this is the wiring.
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import type { AnyRoute } from '@tanstack/react-router'
import type * as I18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageNamespace } from '../i18n/namespaces'
import { areaNamesOf } from './routeUnits'
import type { RouteUnits } from './routeUnits'

/** The registry by any name, as the growing tree reads it. */
const units = (registry: RouteUnits): RouteUnits => registry

const { loadCurrentUser } = vi.hoisted(() => ({ loadCurrentUser: vi.fn() }))
vi.mock('./currentUser', () => ({ loadCurrentUser }))

const ME = {
  id: '018f2d6e-8a51-7c3e-9b1a-2f4c6d8e0a12',
  email: 'owner@acme-sa.example',
  display_name: 'Owner',
  organisations: [
    {
      role: 'org_owner',
      organisation: { id: '018f2d6e-8a51-7c3e-9b1a-2f4c6d8e0a13', slug: 'acme-sa', name: 'Acme' },
    },
  ],
}

/** A fresh application as a build runs it: no catalogue preloaded, nothing fetched. */
async function application(path: string) {
  vi.resetModules()
  vi.stubEnv('MODE', 'development')
  vi.doMock('i18next', async () => {
    const actual = await vi.importActual<typeof I18next>('i18next')
    return { ...actual, default: actual.default.createInstance() }
  })
  window.history.replaceState(null, '', path)
  const { authAdapter } = await import('../auth/oidc')
  vi.spyOn(authAdapter, 'restoreSession').mockResolvedValue(true)
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
  vi.spyOn(authAdapter, 'getUser').mockReturnValue({ realm: 'acme-sa' })
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    user: { realm: 'acme-sa' },
    generation: 1,
    credentialGeneration: 1,
  })
  loadCurrentUser.mockResolvedValue({ me: ME, generation: 1, credentialGeneration: 1 })
  const i18n = await import('../i18n')
  const { createAppRouter } = await import('./routeTree')
  const router = await createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  /** What the route table and the catalogues held each time the table was rebuilt. */
  const rebuilds: { ids: string[]; has: (namespaces: MessageNamespace[]) => boolean }[] = []
  const setRoutes = router.setRoutes.bind(router)
  vi.spyOn(router, 'setRoutes').mockImplementation((caches) => {
    setRoutes(caches)
    const loaded = new Map<string, boolean>()
    rebuilds.push({
      ids: Object.keys(router.routesById),
      has: (namespaces) =>
        namespaces.every((namespace) => {
          if (!loaded.has(namespace)) loaded.set(namespace, i18n.hasNamespaces([namespace]))
          return loaded.get(namespace) === true
        }),
    })
    // Read now, not when the assertion runs: the catalogues only ever grow.
    rebuilds.at(-1)?.has(['people', 'home', 'workspace', 'docs', 'status', 'support'])
  })
  return { router, i18n, rebuilds }
}

/** An id only the area's own routes have: its placeholders end in the area's name or in `$`. */
const PEOPLE_ONLY = '/$org/people/$memberId'
const WORKSPACE_ONLY = '/$org/workspace/$channelId'

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.clear()
})
afterEach(() => {
  vi.doUnmock('i18next')
  vi.unstubAllEnvs()
})

describe('before anyone goes anywhere', () => {
  it('holds the entry routes and no route of any area', async () => {
    const { router, i18n } = await application('/login')
    await router.load()
    const ids = Object.keys(router.routesById)
    expect(ids).toEqual(
      expect.arrayContaining([
        '/',
        '/login',
        '/auth/callback',
        '/espace/callback',
        '/invitations/accept/$organisationId/$organisationSlug',
      ])
    )
    expect(ids).not.toContain(PEOPLE_ONLY)
    expect(ids).not.toContain(WORKSPACE_ONLY)
    expect(router.state.matches.at(-1)?.routeId).toBe('/login')
    expect(i18n.hasNamespaces(['people'])).toBe(false)
    expect(i18n.hasNamespaces(['workspace'])).toBe(false)
  })
})

describe('an address inside one area', () => {
  it('adds the layout and that area, with their namespaces, and no other area', async () => {
    const { router, i18n, rebuilds } = await application('/acme-sa/people')
    await router.load()

    expect(router.state.location.pathname).toBe('/acme-sa/people')
    expect(router.state.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/$org',
      '/$org/people',
    ])
    const ids = Object.keys(router.routesById)
    expect(ids).toContain(PEOPLE_ONLY)
    // Aide arrives with the layout; the workspace, and the libraries behind it, do not.
    expect(ids).toContain('/$org/help')
    expect(ids).not.toContain(WORKSPACE_ONLY)
    expect(i18n.hasNamespaces(['people', 'status', 'support', 'workspace'])).toBe(true)
    expect(i18n.hasNamespaces(['docs'])).toBe(false)
    expect(i18n.hasNamespaces(['home'])).toBe(false)

    // The table was rebuilt once, and the namespaces were already there when it was: a route
    // that can be matched can be rendered.
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0]?.ids).toContain(PEOPLE_ONLY)
    expect(rebuilds[0]?.has(['people', 'status', 'support', 'workspace'])).toBe(true)
  })

  it('adds a second area when the person goes there, and its namespace with it', async () => {
    const { router, i18n, rebuilds } = await application('/acme-sa/people')
    await router.load()
    await router.navigate({ to: '/$org/home', params: { org: 'acme-sa' } })

    expect(router.state.matches.at(-1)?.routeId).toBe('/$org/home')
    expect(i18n.hasNamespaces(['home'])).toBe(true)
    expect(rebuilds).toHaveLength(2)
    expect(rebuilds[1]?.has(['home'])).toBe(true)
    expect(Object.keys(router.routesById)).not.toContain(WORKSPACE_ONLY)

    // Going back to an area that is already there rebuilds nothing.
    await router.navigate({ to: '/$org/people', params: { org: 'acme-sa' } })
    expect(router.state.matches.at(-1)?.routeId).toBe('/$org/people')
    expect(rebuilds).toHaveLength(2)
  })
})

describe('a simulation build', () => {
  const MOCK_IDP = '/__mock-idp/authorize'

  it('fetches the mock identity provider page and its namespace when it is opened, not before', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', '1')
    vi.stubEnv('VITE_AUTH_MODE', 'mock')
    const { router, i18n } = await application('/login')
    await router.load()
    expect(i18n.hasNamespaces(['mockidp'])).toBe(false)
    expect(i18n.hasNamespaces(['messaging'])).toBe(false)

    await router.navigate({ href: `${MOCK_IDP}?state=synthetic` })
    expect(router.state.matches.at(-1)?.routeId).toBe(MOCK_IDP)
    expect(router.state.location.href).toBe(`${MOCK_IDP}?state=synthetic`)
    expect(i18n.hasNamespaces(['mockidp'])).toBe(true)
    // The other simulation route was not opened, and was not fetched.
    expect(i18n.hasNamespaces(['messaging'])).toBe(false)
  })

  it('has no such address in any other build: it is an organisation that does not exist', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    const { router, i18n } = await application(MOCK_IDP)
    await router.load()
    expect(router.state.matches.map((match) => match.routeId)).not.toContain(MOCK_IDP)
    expect(router.state.matches[1]?.routeId).toBe('/$org')
    expect(i18n.hasNamespaces(['mockidp'])).toBe(false)
  })
})

describe('the route units', () => {
  it('answer exactly the addresses their routes have, so no address waits on the wrong unit', async () => {
    const { ROUTE_UNITS } = await import('./routeTree')
    for (const name of areaNamesOf(ROUTE_UNITS)) {
      const routes: readonly AnyRoute[] = await units(ROUTE_UNITS)[name]!.fetch()
      const segments = new Set(
        routes.map(
          (route) =>
            String((route.options as { path?: string }).path)
              .split('/')
              .filter(Boolean)[0]
        )
      )
      // An area with no segment of its own arrives with the layout, whatever its addresses.
      const declared = units(ROUTE_UNITS)[name]!.segments
      if (declared.length > 0) expect([...segments].sort(), name).toEqual([...declared].sort())
    }
    // It fetches every area of the console, which is every screen's module: more than the five
    // seconds a test has by default once the machine is busy with other suites.
  }, 30_000)

  it('add up to the whole tree: every route `buildRouteTree` registers is some unit’s', async () => {
    const { buildRouteTree } = await import('./routeTree')
    const whole = Object.keys(createRouter({ routeTree: await buildRouteTree() }).routesById)
    const { router } = await application('/login')
    await router.load()
    const { ROUTE_UNITS } = await import('./routeTree')
    for (const name of areaNamesOf(ROUTE_UNITS)) {
      const [segment] = units(ROUTE_UNITS)[name]!.segments
      if (segment !== undefined) await router.navigate({ href: `/acme-sa/${segment}` })
    }
    // Everything the whole tree has, the grown one has too. (It also keeps its placeholders
    // findable by id, which the whole tree never had.)
    expect(Object.keys(router.routesById)).toEqual(expect.arrayContaining(whole))
  }, 30_000)
})

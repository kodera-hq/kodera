// The route tree as it grows (`./lazyRouteTree.ts`), against a registry of units this test
// controls: when each one arrives, and whether it arrives at all. The real registry
// (`ROUTE_UNITS` in `./routeTree.ts`) is exercised by `./routeTree.lazy.test.tsx`; here the point is the
// mechanism — what the router matches before a unit is there, what the person sees while it is
// fetched, and that a unit is fetched once, attached once, and asked for again after a failure.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { AnyRoute } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { createLazyRouteTree } from './lazyRouteTree'
import { rootRoute } from './root-route'
import type { RouteUnits } from './routeUnits'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

/** The registry this test controls, handed to the tree as the application hands it its own. */
let units: Record<string, { segments: readonly string[]; fetch: () => Promise<never> }> = {}

/** How often the organisation layout's guard ran: once per navigation that reaches it, never twice. */
let guardRuns = 0
let fetches: Record<string, Deferred<readonly AnyRoute[]>[]> = {}

function organisationRoutes() {
  const layout = createRoute({
    getParentRoute: () => rootRoute,
    path: '$org',
    beforeLoad: () => {
      guardRuns++
    },
    notFoundComponent: () => <p>organisation not found</p>,
    component: () => (
      <main>
        <h1>shell</h1>
        <Outlet />
      </main>
    ),
  })
  const area = (path: string, text: string) =>
    createRoute({ getParentRoute: () => layout, path, component: () => <p>{text}</p> })
  return {
    layout,
    home: area('home', 'home screen'),
    people: area('people', 'people screen'),
    member: area('people/$memberId', 'member screen'),
  }
}

function register(name: string, segments: readonly string[]) {
  fetches[name] = []
  units[name] = {
    segments,
    fetch: () => {
      const next = deferred<readonly AnyRoute[]>()
      fetches[name]?.push(next)
      return next.promise as Promise<never>
    },
  }
}

const login = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => <p>login screen</p>,
})

/** Routes beside the organisation that are fetched on demand, and how often each was asked for. */
let besideFetches: Deferred<readonly AnyRoute[]>[] = []
const beside = createRoute({
  getParentRoute: () => rootRoute,
  path: '/__preview',
  component: () => <p>preview screen</p>,
})

async function open(path: string) {
  const tree = createLazyRouteTree([login], units as unknown as RouteUnits, [
    {
      paths: ['/__preview'],
      fetch: () => {
        const next = deferred<readonly AnyRoute[]>()
        besideFetches.push(next)
        return next.promise
      },
    },
  ])
  const router = createRouter({
    routeTree: tree.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  tree.bind(router)
  render(<RouterProvider router={router} />)
  return router
}

const ids = (router: { routesById: object }) => Object.keys(router.routesById)
/** The organisation layout's own pending screen, which the placeholder shows in its place. */
const sessionLoading = () => i18n.t('console.shell.session.status-restoring')

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  units = {}
  fetches = {}
  besideFetches = []
  guardRuns = 0
  register('organisation', [])
  register('home', ['home'])
  register('people', ['people'])
})

describe('the entry routes', () => {
  it('render without fetching any unit', async () => {
    const router = await open('/login')
    expect(await screen.findByText('login screen')).toBeVisible()
    expect(fetches.organisation).toHaveLength(0)
    expect(fetches.home).toHaveLength(0)
    expect(ids(router)).toContain('/login')
  })
})

describe('an address inside an organisation, before its layout is there', () => {
  it('shows the session-loading screen at once and fetches the layout and that one area', async () => {
    await open('/acme-sa/home')
    expect(await screen.findByText(sessionLoading())).toBeInTheDocument()
    expect(fetches.organisation).toHaveLength(1)
    expect(fetches.home).toHaveLength(1)
    expect(fetches.people).toHaveLength(0)
    expect(screen.queryByText('home screen')).not.toBeInTheDocument()
  })

  it('attaches the real routes when both have arrived, and lands on the same address', async () => {
    const router = await open('/acme-sa/home?tab=1#top')
    const routes = organisationRoutes()
    await waitFor(() => expect(fetches.home).toHaveLength(1))
    // One of the two is not enough: the area's screen needs the layout, and the layout's
    // outlet needs the area.
    await act(async () => fetches.organisation?.[0]?.resolve([routes.layout]))
    expect(screen.queryByText('home screen')).not.toBeInTheDocument()
    await act(async () => fetches.home?.[0]?.resolve([routes.home]))

    expect(await screen.findByText('home screen')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'shell' })).toBeVisible()
    expect(router.state.location.href).toBe('/acme-sa/home?tab=1#top')
    expect(router.history.length).toBe(1)
    expect(guardRuns).toBe(1)
    expect(router.routesById).toHaveProperty(['/$org/home'], routes.home)
  })

  it('fetches only the layout for an address no area answers, which is then not found as before', async () => {
    await open('/acme-sa/nowhere')
    const routes = organisationRoutes()
    await waitFor(() => expect(fetches.organisation).toHaveLength(1))
    await act(async () => fetches.organisation?.[0]?.resolve([routes.layout]))
    expect(await screen.findByText('organisation not found')).toBeVisible()
    expect(fetches.home).toHaveLength(0)
    expect(fetches.people).toHaveLength(0)
  })
})

describe('an area that is still missing, with the layout on screen', () => {
  async function onHome() {
    const router = await open('/acme-sa/home')
    const routes = organisationRoutes()
    await waitFor(() => expect(fetches.home).toHaveLength(1))
    await act(async () => {
      fetches.organisation?.[0]?.resolve([routes.layout])
      fetches.home?.[0]?.resolve([routes.home])
    })
    await screen.findByText('home screen')
    guardRuns = 0
    return { router, routes }
  }

  it('keeps the page the person is leaving until the area arrives, and runs the guard once', async () => {
    const { router, routes } = await onHome()
    await act(async () => {
      void router.navigate({ href: '/acme-sa/people/42' })
    })
    await waitFor(() => expect(fetches.people).toHaveLength(1))
    // Still the old page, whole: no loading screen replaces the shell, and the layout's guard
    // has not run for a navigation that has not reached it yet.
    expect(screen.getByText('home screen')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'shell' })).toBeVisible()
    expect(screen.queryByText(sessionLoading())).not.toBeInTheDocument()
    expect(guardRuns).toBe(0)

    await act(async () => fetches.people?.[0]?.resolve([routes.people, routes.member]))
    expect(await screen.findByText('member screen')).toBeVisible()
    expect(guardRuns).toBe(1)
    expect(fetches.organisation).toHaveLength(1)
    expect(router.state.location.pathname).toBe('/acme-sa/people/42')
  })

  it('does not fetch an area twice, however many navigations ask for it', async () => {
    const { router, routes } = await onHome()
    await act(async () => {
      void router.navigate({ href: '/acme-sa/people' })
    })
    await act(async () => {
      void router.navigate({ href: '/acme-sa/people/7' })
    })
    await waitFor(() => expect(fetches.people).toHaveLength(1))
    await act(async () => fetches.people?.[0]?.resolve([routes.people, routes.member]))
    expect(await screen.findByText('member screen')).toBeVisible()

    await act(async () => {
      void router.navigate({ href: '/acme-sa/home' })
    })
    await screen.findByText('home screen')
    await act(async () => {
      void router.navigate({ href: '/acme-sa/people' })
    })
    expect(await screen.findByText('people screen')).toBeVisible()
    expect(fetches.people).toHaveLength(1)
  })

  it('asks again after a fetch that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { router, routes } = await onHome()
    await act(async () => {
      void router.navigate({ href: '/acme-sa/people' })
    })
    await waitFor(() => expect(fetches.people).toHaveLength(1))
    await act(async () => fetches.people?.[0]?.reject(new Error('chunk unavailable')))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(screen.queryByText('people screen')).not.toBeInTheDocument()
    // The address is still answered by the placeholder, not by the area's route.
    expect(router.routesById).not.toHaveProperty(['/$org/people'], routes.people)

    await act(async () => {
      void router.navigate({ href: '/acme-sa/people' })
    })
    await waitFor(() => expect(fetches.people).toHaveLength(2))
    await act(async () => fetches.people?.[1]?.resolve([routes.people, routes.member]))
    expect(await screen.findByText('people screen')).toBeVisible()
  })
})

describe('a route beside the organisation that is fetched on demand', () => {
  it('is not fetched by a page that does not open it', async () => {
    await open('/login')
    expect(await screen.findByText('login screen')).toBeVisible()
    expect(besideFetches).toHaveLength(0)
  })

  it('is fetched when its address is opened, and answers it, without the organisation', async () => {
    const router = await open('/__preview')
    await waitFor(() => expect(besideFetches).toHaveLength(1))
    expect(screen.queryByText('preview screen')).not.toBeInTheDocument()
    await act(async () => besideFetches[0]?.resolve([beside]))
    expect(await screen.findByText('preview screen')).toBeVisible()
    expect(router.state.location.pathname).toBe('/__preview')
    expect(router.routesById).toHaveProperty(['/__preview'], beside)
    expect(fetches.organisation).toHaveLength(0)
  })

  it('is not found, and not asked for again and again, when nothing answers its address after all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router = await open('/__preview')
    await waitFor(() => expect(besideFetches).toHaveLength(1))
    await act(async () => besideFetches[0]?.resolve([]))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(screen.queryByText('preview screen')).not.toBeInTheDocument()
    expect(besideFetches).toHaveLength(1)
  })
})

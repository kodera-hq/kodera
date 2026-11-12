// The route tree as it grows: the entry routes at first, an organisation's layout and each area
// of the console added the first time someone goes there (the units of `./routeTree.ts`).
//
// The router matches addresses against the tree it was given, so a part of the tree that has not
// been fetched needs something to match in its place. That is a placeholder route: it has the
// address of what is missing and one job, in `beforeLoad` — fetch the unit and its message
// namespaces, put the real routes in the tree, and send the router to the same address again,
// where the real routes now answer. A placeholder is never a page of its own; the one thing it
// can end up showing is the error screen, when the fetch fails.
//
// Two kinds, because what the person sees while waiting differs:
//
// - before the organisation layout is there, one placeholder answers everything under `/$org`
//   and shows the session-loading screen at once, which is what the layout shows next. It has
//   the layout's own id, so the router carries that one pending screen across the hand-over
//   instead of drawing it twice;
// - once the layout is on screen, an area that is still missing is answered next to the layout,
//   not inside it, and shows nothing of its own: the page the person is leaving stays up until
//   the area arrives, as it does for any navigation that waits on a loader, and the layout keeps
//   that page's title until then (`./lazyRouteWait.ts`). Placing it below the layout would run
//   the layout's session guard twice for one navigation.
//
// An address under `/$org` that no unit answers is not a placeholder's business: it reaches the
// organisation layout and is not found there, exactly as it was when the tree was whole.
//
// A few routes sit beside the organisation rather than below it and are fetched on demand all
// the same (`LazyRoutes`): each has a placeholder at its own address, which works as an area's
// does.

import { createRoute, notFound, redirect } from '@tanstack/react-router'
import type { AnyRoute, AnyRouter } from '@tanstack/react-router'
import { beginLazyRouteWait, endLazyRouteWaits } from './lazyRouteWait'
import { rootRoute } from './root-route'
import { areaNamesOf } from './routeUnits'
import type { RouteUnits } from './routeUnits'
import { SessionLoading } from './SessionLoading'

/** Routes outside any organisation that are fetched the first time one of their addresses is opened. */
export interface LazyRoutes {
  /** The full paths these routes answer; each gets a placeholder until they are fetched. */
  readonly paths: readonly string[]
  /** The routes, once their module and its namespaces are both there. */
  readonly fetch: () => Promise<readonly AnyRoute[]>
}

export interface LazyRouteTree {
  /** The tree to hand to `createRouter`: the root route, holding whatever is attached so far. */
  readonly routeTree: typeof rootRoute
  /** The router whose route table follows this tree as it grows. */
  bind(router: AnyRouter): void
}

/**
 * @param entryRoutes the routes every visitor gets, in the order the tree lists them.
 * @param units the layout and the areas to fetch on demand.
 * @param lazyRoutes routes outside any organisation to fetch on demand.
 */
export function createLazyRouteTree(
  entryRoutes: readonly AnyRoute[],
  units: RouteUnits,
  lazyRoutes: readonly LazyRoutes[] = []
): LazyRouteTree {
  let router: AnyRouter | undefined
  const areaNames = areaNamesOf(units)
  // An area with no address of its own to wait for arrives with the layout.
  const layoutAreaNames = areaNames.filter((name) => units[name]?.segments.length === 0)
  const attached = new Map<string, readonly AnyRoute[]>()
  const fetching = new Map<string, Promise<void>>()

  /** The area that answers the address on its own, if the address is inside one. */
  function areaOf(pathname: string): string | undefined {
    const segment = pathname.split('/').filter((part) => part !== '')[1]
    if (segment === undefined) return undefined
    return areaNames.find((name) => units[name]?.segments.includes(segment))
  }

  /** `name` is a unit's, or the position of a `lazyRoutes` entry (`#0`, `#1`…). */
  function fetchUnit(name: string): Promise<void> {
    if (attached.has(name)) return Promise.resolve()
    const pending = fetching.get(name)
    if (pending !== undefined) return pending
    const definition = name.startsWith('#') ? lazyRoutes[Number(name.slice(1))] : units[name]
    if (definition === undefined) return Promise.reject(new Error(`No route unit "${name}".`))
    const request = definition
      .fetch()
      .then((routes: readonly AnyRoute[]) => {
        attached.set(name, routes)
      })
      // A fetch that failed is forgotten: the error screen's retry asks again.
      .finally(() => fetching.delete(name))
    fetching.set(name, request)
    return request
  }

  /** Fetches the units, attaches them, and restarts the navigation on the grown tree. */
  async function grow(names: readonly string[], href: string): Promise<never> {
    // Until the router settles on the page this leads to, the layout goes on describing the page
    // that is on screen (`./lazyRouteWait.ts`). The router ends the wait (`bind`); a fetch that
    // fails ends it here, since the error screen is then what is on screen.
    beginLazyRouteWait()
    try {
      await Promise.all(names.map(fetchUnit))
    } catch (error) {
      endLazyRouteWaits()
      throw error
    }
    // Nothing to put where the placeholder is: going to the same address again would only come
    // back here. It is an address no route answers.
    if (names.every((name) => attached.get(name)?.length === 0)) throw notFound()
    assemble()
    if (router !== undefined) {
      // The tree object is the same root route, so `router.update({ routeTree })` would see no
      // change and keep its old table. These two are what it runs when the tree did change.
      router.setRoutes(router.buildRouteTree())
      // A placeholder that has just left the tree can still be named by a match the router
      // holds: the pending screen on display, or the error screen of a fetch that failed
      // earlier. The router looks such a route up by id when it lets go of the match, so every
      // placeholder stays findable by id. Matching reads the tree, not this table, and a real
      // route that took over a placeholder's id keeps it.
      for (const placeholder of placeholders) {
        // A placeholder that was never in a tree has no id yet, and no match to be found by.
        const id: string | undefined = placeholder.id
        if (id !== undefined) router.routesById[id] ??= placeholder
      }
    }
    throw redirect({ href, replace: true })
  }

  const organisationPlaceholder = createRoute({
    getParentRoute: () => rootRoute,
    path: '$org',
    // The organisation layout's own pending screen and timing (`./org-route.tsx`).
    pendingComponent: SessionLoading,
    pendingMs: 0,
    pendingMinMs: 0,
    beforeLoad: ({ location }) => {
      const area = areaOf(location.pathname)
      return grow(
        ['organisation', ...layoutAreaNames, ...(area === undefined ? [] : [area])],
        location.href
      )
    },
  })
  const organisationRest = createRoute({ getParentRoute: () => organisationPlaceholder, path: '$' })
  organisationPlaceholder.addChildren([organisationRest])

  const areaPlaceholders = new Map<string, readonly AnyRoute[]>(
    areaNames.map((name) => [
      name,
      (units[name]?.segments ?? []).flatMap((segment) =>
        [`$org/${segment}`, `$org/${segment}/$`].map((path) =>
          createRoute({
            getParentRoute: () => rootRoute,
            path,
            beforeLoad: ({ location }) => grow([name], location.href),
          })
        )
      ),
    ])
  )

  const lazyRoutePlaceholders = lazyRoutes.map(({ paths }, index) =>
    paths.map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        beforeLoad: ({ location }) => grow([`#${index}`], location.href),
      })
    )
  )

  const placeholders: readonly AnyRoute[] = [
    organisationPlaceholder,
    organisationRest,
    ...[...areaPlaceholders.values()].flat(),
    ...lazyRoutePlaceholders.flat(),
  ]

  function assemble(): void {
    const children: AnyRoute[] = [...entryRoutes]
    lazyRoutePlaceholders.forEach((group, index) => {
      children.push(...(attached.get(`#${index}`) ?? group))
    })
    const organisation = attached.get('organisation')?.[0]
    if (organisation === undefined) {
      children.push(organisationPlaceholder)
    } else {
      organisation.addChildren(areaNames.flatMap((name) => attached.get(name) ?? []))
      children.push(organisation)
      for (const name of areaNames) {
        if (!attached.has(name)) children.push(...(areaPlaceholders.get(name) ?? []))
      }
    }
    rootRoute.addChildren(children)
  }

  assemble()
  return {
    routeTree: rootRoute,
    bind(bound) {
      router = bound
      bound.subscribe('onResolved', endLazyRouteWaits)
    },
  }
}

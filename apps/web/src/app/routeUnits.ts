// A lazy route unit: a part of the route tree the application fetches only when a person goes
// there. The units themselves are listed in `./routeTree.ts`, one entry per area (ADR-0005), and
// attached to the running router by `./lazyRouteTree.ts`.
//
// A unit's `load` goes through `withNamespaces` (`src/i18n/index.ts`), which delivers the module
// together with the message namespaces its screens read: a route never exists in the router
// before its text does.

import type { AnyRoute } from '@tanstack/react-router'

export interface RouteUnit<TRoutes extends readonly AnyRoute[]> {
  /**
   * The first path segments below `/$org` this unit answers. An area with none is fetched with
   * the layout instead of on its own; the layout itself has none.
   */
  readonly segments: readonly string[]
  /** The unit's top-level routes, once its module and its namespaces are both there. */
  readonly fetch: () => Promise<TRoutes>
}

/** The layout, and one unit per area below it, in the order the route tree lists their routes. */
export type RouteUnits = Readonly<Record<string, RouteUnit<readonly AnyRoute[]>>> & {
  /** The `/$org` layout itself: exactly one route, which every area hangs below. */
  readonly organisation: RouteUnit<readonly [AnyRoute]>
}

export function unit<TModule, const TRoutes extends readonly AnyRoute[]>(definition: {
  readonly segments: readonly string[]
  readonly load: () => Promise<TModule>
  /** The unit's top-level routes, in the order the route tree lists them. */
  readonly routes: (module: TModule) => TRoutes
}): RouteUnit<TRoutes> {
  return {
    segments: definition.segments,
    fetch: async () => definition.routes(await definition.load()),
  }
}

/** The areas of a registry: every unit but the layout, in the order they are listed. */
export function areaNamesOf(units: RouteUnits): string[] {
  return Object.keys(units).filter((name) => name !== 'organisation')
}

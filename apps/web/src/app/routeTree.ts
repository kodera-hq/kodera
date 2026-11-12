// The whole route tree, assembled in one place (ADR-0005): the top-level
// routes that sit outside any organisation, imported here, plus the `/$org`
// layout and one unit per area below it, listed in `ROUTE_UNITS` and fetched
// by the browser only when someone goes there. The mock identity provider's
// route is not imported here at all.
//
// Two builders, one tree:
//
// - `createAppRouter` is what the application runs. Its tree starts as the
//   entry routes and grows a unit at a time (`./lazyRouteTree.ts`), so the
//   sign-in screen is not delivered with the workspace behind it.
// - `buildRouteTree` is the same tree with every unit attached. It is where
//   the tree's types come from — the router `createAppRouter` returns is
//   typed as this one, which is what it becomes — and what a test that reads
//   the route table builds.

import { createRouter } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { callbackRoute } from './callback-route'
import { espaceCallbackRoute } from './espace-callback-route'
import { invitationRoute } from '../features/invitation/route'
import { loginRoute } from '../features/login/routes'
import { entryCataloguesReady, withNamespaces } from '../i18n'
import { ORGANISATION_NAMESPACES } from '../i18n/namespaces'
import { indexRoute } from './index-route'
import { createLazyRouteTree } from './lazyRouteTree'
import type { LazyRoutes } from './lazyRouteTree'
import { rootRoute } from './root-route'
import { RouteError } from './RouteError'
import { unit } from './routeUnits'

/**
 * The lazy route units: the `/$org` layout (`organisation`: the session guard, `GET /me` and the
 * shell) and, below it, one unit per area of the console. An area is one entry here and its
 * routes are declared in its own `routes.tsx`, as ADR-0005 has it; what changed is that the entry
 * is an `import()`, so the area is fetched the first time its address is asked for.
 *
 * An entry names the message namespaces its screens read, beside the import (a literal list, or
 * a list `src/i18n/namespaces.ts` exports). `withNamespaces`
 * delivers the two together, and `npm run i18n:check` follows the imports of each unit and fails
 * when a screen reads a namespace its unit does not name
 * (`scripts/i18n/route-namespaces.ts`): add the namespace here, in the same change as the first
 * key that needs it. An area may count on `organisation`'s namespaces, and every unit on the
 * entry namespaces (`src/i18n/namespaces.ts`).
 *
 * Only an `import()` may reach an area from this file. A static import of anything under
 * `src/features/<area>/` would put that area, and whatever it imports, back into what every
 * visitor downloads; `scripts/check-bundle-budget.mjs` measures that on each build.
 */
export const ROUTE_UNITS = {
  organisation: unit({
    segments: [],
    load: () => withNamespaces(ORGANISATION_NAMESPACES, () => import('./org-route')),
    routes: (module) => [module.orgRoute],
  }),
  home: unit({
    segments: ['home'],
    load: () => withNamespaces(['home'], () => import('../features/home/routes')),
    routes: (module) => [module.homeRoute],
  }),
  status: unit({
    segments: ['status'],
    load: () => withNamespaces([], () => import('../features/status/routes')),
    routes: (module) => [module.statusRoute],
  }),
  workspace: unit({
    segments: ['workspace'],
    load: () => withNamespaces(['docs'], () => import('../features/workspace/routes')),
    routes: (module) => [
      module.workspaceRoute.addChildren([module.workspaceIndexRoute, module.workspaceChannelRoute]),
    ],
  }),
  people: unit({
    segments: ['people'],
    load: () => withNamespaces(['people'], () => import('../features/people/routes')),
    routes: (module) => [
      module.peopleRoute,
      module.peopleInviteRoute,
      module.peopleOnSiteRoute,
      module.peopleImportRoute,
      module.peopleImportResultRoute,
      module.peopleMemberRoute,
    ],
  }),
  domain: unit({
    segments: ['domain'],
    load: () => withNamespaces(['domain'], () => import('../features/domain/routes')),
    routes: (module) => [module.domainRoute],
  }),
  invoices: unit({
    segments: ['invoices'],
    load: () => withNamespaces(['invoices'], () => import('../features/invoices/routes')),
    routes: (module) => [
      module.invoicesRoute,
      module.invoiceDetailRoute,
      module.invoicesSubscriptionRoute,
    ],
  }),
  // Aide is one click from every screen's header and is small, so it comes with the layout
  // rather than on its own (no segment: see `RouteUnit.segments`). Its address is also written
  // in one place only, under `src/features/support/` (`help-links.test.ts`), and is not
  // repeated here.
  support: unit({
    segments: [],
    load: () => withNamespaces([], () => import('../features/support/routes')),
    routes: (module) => [module.supportRoute, module.supportAliasRoute],
  }),
  order: unit({
    segments: ['order'],
    load: () => withNamespaces([], () => import('../features/order/routes')),
    routes: (module) => [module.orderRouteWithChildren],
  }),
  federation: unit({
    segments: ['federation'],
    load: () => withNamespaces(['federation'], () => import('../features/federation/routes')),
    routes: (module) => [module.federationRoute],
  }),
  security: unit({
    segments: ['security'],
    load: () => withNamespaces([], () => import('../features/security/routes')),
    routes: (module) => [module.securityRoute, module.securityMfaRoute],
  }),
  appearance: unit({
    segments: ['appearance'],
    load: () => withNamespaces([], () => import('../features/appearance/routes')),
    routes: (module) => [module.appearanceRoute],
  }),
}

/**
 * `/__mock-idp/authorize`, loaded ONLY when this exact condition — written
 * out here, not through a function call — is `true` (ADR-0007: "anything
 * reachable in a production build that fabricates an authorization code
 * would be a real vulnerability"). `mock-idp-gate.ts`'s `mockIdpEnabled`
 * carries the same truth table as a pure, independently tested function
 * (`tests/unit/auth/mock-idp-gate.test.ts`), but calling it from here would
 * defeat the point: Vite's env-replace plugin substitutes the literal
 * build-time value for `import.meta.env.VITE_ENABLE_MSW` /
 * `VITE_AUTH_MODE` wherever those two expressions appear textually, so a
 * production build (`VITE_AUTH_MODE=oidc VITE_ENABLE_MSW=0`) turns the `if`
 * below into `if ('0' === '1' && 'oidc' === 'mock')` — a condition made of
 * nothing but literals, which the minifier folds to `false` and removes,
 * taking the `import()` it guards with it. A value that only exists after a
 * function call returns (`mockIdpEnabled(mswEnabled(), authMode())`, the
 * previous shape of this gate) cannot be folded the same way: the call is
 * still live code, so the bundler cannot prove it dead, and the module stays
 * reachable — which is exactly how `./mock-idp-route` (and
 * `../auth/mock-idp` beneath it) shipped in the production bundle console
 * PR #35 was reviewed at (75deb37), even though the array below never
 * actually added it to the tree. `scripts/check-production-bundle.sh` builds
 * with `VITE_AUTH_MODE=oidc VITE_ENABLE_MSW=0` and greps the emitted JS to
 * prove this stays true; `src/app/routeTree.test.ts` proves both the runtime
 * behaviour and the static shape (no static `import … from './mock-idp-route'`
 * anywhere in this file).
 */
// `import()` in a TYPE position, which `consistent-type-imports` would
// normally have us write as `import type … from './mock-idp-route'`. Not
// here: that form starts a line with `import`, which is exactly what
// `routeTree.test.ts`'s static-reachability guard forbids in this file, and
// that guard is a security boundary (ADR-0007), not a style preference. Both
// forms are erased before any JavaScript is emitted, so the production
// bundle is unaffected either way — only the guard can tell them apart, and
// it is right to. Naming the type at all is what stops the route below being
// typed `AnyRoute`, which is the top type: spreading one into the children
// array collapses the inference for the WHOLE tree, and every
// `useLoaderData()` in the console silently becomes `any`
// (`routeTree.types.test.tsx`).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type MockIdpRoute = (typeof import('./mock-idp-route'))['mockIdpRoute']

async function mockIdpRoutes(): Promise<readonly MockIdpRoute[]> {
  if (import.meta.env.VITE_ENABLE_MSW === '1' && import.meta.env.VITE_AUTH_MODE === 'mock') {
    const { mockIdpRoute } = await withNamespaces(['mockidp'], () => import('./mock-idp-route'))
    return [mockIdpRoute]
  }
  return []
}

/**
 * `/__demo-messaging`, gated by the same literal condition and for the same
 * mechanical reason as the mock identity provider above: written out here
 * rather than called through `messagingDemoEnabled`
 * (`../features/messaging/demo-gate.ts`) so Vite folds it to `false` at build
 * time and drops the `import()` with it.
 *
 * What it guards is different, though, and worth naming. The demo surface is
 * a picture of Tchap — La Suite's messaging service, which kodera.io
 * installs and operates for a customer (`contracts/core-api.openapi.yaml`,
 * `TenantApp.app`) — not a messenger this repository implements. Shipping a
 * fictional conversation into a customer's own console would claim a product
 * that does not exist here, so it is excluded from a production build the
 * same provable way, and `scripts/check-production-bundle.sh` greps the
 * emitted JavaScript for its route path, its root element's marker attribute
 * and one of its fixture's own sentences to prove it.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type MessagingDemoRoute = (typeof import('../features/messaging/demo-route'))['messagingDemoRoute']

async function messagingDemoRoutes(): Promise<readonly MessagingDemoRoute[]> {
  if (import.meta.env.VITE_ENABLE_MSW === '1' && import.meta.env.VITE_AUTH_MODE === 'mock') {
    const { messagingDemoRoute } = await withNamespaces(
      ['messaging'],
      () => import('../features/messaging/demo-route')
    )
    return [messagingDemoRoute]
  }
  return []
}

/**
 * `/claim/$organisationId/$organisationSlug`, the first-owner journey
 * (docs/specs/09-owner-claim.md), behind `VITE_FIRST_OWNER_JOURNEY`. Off by default, and
 * written as a literal comparison for the same folding reason as the two gates above, so a
 * build without it carries neither the route nor the screen.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ClaimRoute = (typeof import('../features/owner-claim/route'))['claimRoute']

async function firstOwnerRoutes(): Promise<readonly ClaimRoute[]> {
  if (import.meta.env.VITE_FIRST_OWNER_JOURNEY === '1') {
    const { claimRoute } = await withNamespaces(
      ['claim'],
      () => import('../features/owner-claim/route')
    )
    return [claimRoute]
  }
  return []
}

/** The routes every visitor gets, in the order the tree lists them. Async because the gated
 * claim route above is. */
async function entryRoutes() {
  return [
    indexRoute,
    loginRoute,
    callbackRoute,
    espaceCallbackRoute,
    ...(await firstOwnerRoutes()),
    // An invitation's acceptance, in every build (docs/specs/12-invitation-accept.md).
    invitationRoute,
  ] as const
}

/**
 * The simulation's two routes, each fetched the first time its address is opened, with its
 * namespace: a simulation build registers them on every page, and most pages never open either.
 *
 * The same literal condition as the two gates above, for the same reason: another build folds it
 * to `false` and carries neither the addresses below nor a placeholder for them. Without the
 * condition a placeholder would answer an address whose route can never arrive.
 */
function simulationRoutes(): readonly LazyRoutes[] {
  if (import.meta.env.VITE_ENABLE_MSW === '1' && import.meta.env.VITE_AUTH_MODE === 'mock') {
    return [
      { paths: ['/__mock-idp/authorize'], fetch: mockIdpRoutes },
      { paths: ['/__demo-messaging'], fetch: messagingDemoRoutes },
    ]
  }
  return []
}

/** The route tree the running configuration registers once every unit has
 * been reached — a function, not a module-level constant, so building one
 * reads the environment at CALL time. A constant evaluated at import time
 * would read the environment before a test ever gets to stub it
 * (`src/app/routeTree.test.ts`), and would make every import of this module
 * require the full environment just to resolve. Async because the gated
 * routes and the units are. */
export async function buildRouteTree() {
  const [
    [orgRoute],
    home,
    status,
    workspace,
    people,
    domain,
    invoices,
    support,
    order,
    federation,
    security,
    appearance,
  ] = await Promise.all([
    ROUTE_UNITS.organisation.fetch(),
    ROUTE_UNITS.home.fetch(),
    ROUTE_UNITS.status.fetch(),
    ROUTE_UNITS.workspace.fetch(),
    ROUTE_UNITS.people.fetch(),
    ROUTE_UNITS.domain.fetch(),
    ROUTE_UNITS.invoices.fetch(),
    ROUTE_UNITS.support.fetch(),
    ROUTE_UNITS.order.fetch(),
    ROUTE_UNITS.federation.fetch(),
    ROUTE_UNITS.security.fetch(),
    ROUTE_UNITS.appearance.fetch(),
  ])
  const orgRouteWithChildren = orgRoute.addChildren([
    ...home,
    ...status,
    ...workspace,
    ...people,
    ...domain,
    ...invoices,
    ...support,
    ...order,
    ...federation,
    ...security,
    ...appearance,
  ])
  return rootRoute.addChildren([
    ...(await entryRoutes()),
    ...(await mockIdpRoutes()),
    ...(await messagingDemoRoutes()),
    orgRouteWithChildren,
  ])
}

type WholeRouteTree = Awaited<ReturnType<typeof buildRouteTree>>

/** Same reasoning as `buildRouteTree`: a function `main.tsx` calls once at
 * boot, not a singleton constructed on import.
 *
 * The router starts with the entry routes only and fetches the rest as
 * addresses ask for it. It is created after the entry catalogues of the
 * page's language have arrived, so its first screen has its text. */
export async function createAppRouter(options: { history?: RouterHistory } = {}) {
  await entryCataloguesReady
  const tree = createLazyRouteTree(await entryRoutes(), ROUTE_UNITS, simulationRoutes())
  const router = createRouter({
    // Typed as the tree it grows into: a link to an area is checked against
    // that area's route whether or not the area has been fetched yet.
    routeTree: tree.routeTree as unknown as WholeRouteTree,
    // Every route without a boundary of its own — `/`, `/login`, and each
    // route below `/$org` — fails with the console's own
    // French screen, drawn inside the shell when the shell is on screen.
    defaultErrorComponent: RouteError,
    ...(options.history === undefined ? {} : { history: options.history }),
  })
  tree.bind(router)
  return router
}

export type AppRouter = Awaited<ReturnType<typeof createAppRouter>>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}

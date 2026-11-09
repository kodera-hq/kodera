// The whole route tree, assembled in one place (ADR-0005): one import line
// per area, aggregated onto `orgRoute`, plus the top-level routes that sit
// outside any organisation. The mock identity provider's route is the one
// exception to "one import per area" — it is not imported here at all.

import { createRouter } from '@tanstack/react-router'
import { callbackRoute } from './callback-route'
import { espaceCallbackRoute } from './espace-callback-route'
import { appearanceRoute } from '../features/appearance/routes'
import { domainRoute } from '../features/domain/routes'
import { federationRoute } from '../features/federation/routes'
import { homeRoute } from '../features/home/routes'
import { invitationRoute } from '../features/invitation/route'
import {
  invoiceDetailRoute,
  invoicesRoute,
  invoicesSubscriptionRoute,
} from '../features/invoices/routes'
import { orderRouteWithChildren } from '../features/order/routes'
import {
  peopleImportResultRoute,
  peopleImportRoute,
  peopleInviteRoute,
  peopleMemberRoute,
  peopleOnSiteRoute,
  peopleRoute,
} from '../features/people/routes'
import { securityMfaRoute, securityRoute } from '../features/security/routes'
import { statusRoute } from '../features/status/routes'
import { supportRoute, supportAliasRoute } from '../features/support/routes'
import {
  workspaceChannelRoute,
  workspaceIndexRoute,
  workspaceRoute,
} from '../features/workspace/routes'
import { loginRoute } from '../features/login/routes'
import { indexRoute } from './index-route'
import { orgRoute } from './org-route'
import { rootRoute } from './root-route'
import { RouteError } from './RouteError'

const orgRouteWithChildren = orgRoute.addChildren([
  homeRoute,
  statusRoute,
  workspaceRoute.addChildren([workspaceIndexRoute, workspaceChannelRoute]),
  peopleRoute,
  peopleInviteRoute,
  peopleOnSiteRoute,
  peopleImportRoute,
  peopleImportResultRoute,
  peopleMemberRoute,
  domainRoute,
  invoicesRoute,
  invoiceDetailRoute,
  invoicesSubscriptionRoute,
  supportRoute,
  supportAliasRoute,
  orderRouteWithChildren,
  federationRoute,
  securityRoute,
  securityMfaRoute,
  appearanceRoute,
])

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
    const { mockIdpRoute } = await import('./mock-idp-route')
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
    const { messagingDemoRoute } = await import('../features/messaging/demo-route')
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
    const { claimRoute } = await import('../features/owner-claim/route')
    return [claimRoute]
  }
  return []
}

/** The route tree the running configuration actually registers — a function,
 * not a module-level constant, so building one reads the environment at CALL
 * time. A constant evaluated at import time would read the environment
 * before a test ever gets to stub it (`src/app/routeTree.test.ts`), and
 * would make every import of this module require the full environment just
 * to resolve. Async because `mockIdpRoutes` above is. */
export async function buildRouteTree() {
  return rootRoute.addChildren([
    indexRoute,
    loginRoute,
    callbackRoute,
    espaceCallbackRoute,
    ...(await mockIdpRoutes()),
    ...(await messagingDemoRoutes()),
    ...(await firstOwnerRoutes()),
    // An invitation's acceptance, in every build (docs/specs/12-invitation-accept.md).
    invitationRoute,
    orgRouteWithChildren,
  ])
}

/** Same reasoning as `buildRouteTree`: a function `main.tsx` calls once at
 * boot, not a singleton constructed on import. */
export async function createAppRouter() {
  return createRouter({
    routeTree: await buildRouteTree(),
    // Every route without a boundary of its own — `/`, `/login`, and each
    // route below `/$org` — fails with the console's own
    // French screen, drawn inside the shell when the shell is on screen.
    defaultErrorComponent: RouteError,
  })
}

export type AppRouter = Awaited<ReturnType<typeof createAppRouter>>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}

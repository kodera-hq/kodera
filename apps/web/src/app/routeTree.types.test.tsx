// A type gate, not a behaviour test. `npm run typecheck` is what runs it.
//
// Registering the route tree is what gives every `useLoaderData()`,
// `useParams()` and `navigate()` in the console its types. One route typed
// loosely enough poisons the whole union — TanStack resolves the tree to
// `any` and every call site silently follows, with no error anywhere,
// because `any` is assignable to everything. That is exactly what happened
// when the mock identity provider's conditional route was typed `AnyRoute`
// to keep it behind a dynamic `import()`: `npm run typecheck` stayed green
// for six commits while `me` in `org-route.tsx` was `any`, and the first
// thing to notice was a screen branch built on the typed base failing to
// compile after a rebase.
//
// Nothing here runs. `assertNotAny` fails at COMPILE time the moment the
// tree degrades again, which is the only moment anyone would want to know.

import { createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { orgRoute } from './org-route'
import { buildRouteTree } from './routeTree'

/** `true` only for `any` — `any` is the one type that is both assignable to
 * and from `1`, which is what makes `0 extends 1 & T` collapse. */
type IsAny<T> = 0 extends 1 & T ? true : false

/** Never rendered, never imported by product code. Declaring it a component
 * is what lets it call a route hook without tripping the hook lint rule. */
export function RouteTypeGate() {
  const { me: _me, membership: _membership } = orgRoute.useLoaderData()
  const { org: _org } = orgRoute.useParams()

  // Each of these is `false` while the tree keeps its types, and becomes
  // `true` — a compile error against the `false` annotation — if it does not.
  const loaderIsNotAny: IsAny<typeof _me> = false
  const membershipIsNotAny: IsAny<typeof _membership> = false
  const paramsAreNotAny: IsAny<typeof _org> = false

  return { loaderIsNotAny, membershipIsNotAny, paramsAreNotAny }
}

describe('the route tree', () => {
  it('still registers the organisation layout and its areas', async () => {
    // Ids are assigned when the router is built, not on the raw tree —
    // the same construction `routeTree.test.ts` uses.
    const router = createRouter({ routeTree: await buildRouteTree() })
    expect(Object.keys(router.routesById)).toContain('/$org')
  })

  it('keeps its inferred types, which only `npm run typecheck` can prove', () => {
    // The assertion above this describe block is the real gate; this records
    // that it exists so a reader of the test output knows to look for it.
    expect(RouteTypeGate).toBeTypeOf('function')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { BILLING_OFF_TARGET } from '../features/order/routes'
import { buildRouteTree } from './routeTree'

const setEnv = (vars: Record<string, string>) => {
  for (const [key, value] of Object.entries(vars)) {
    ;(import.meta.env as Record<string, unknown>)[key] = value
  }
}

async function routeIds(): Promise<string[]> {
  const router = createRouter({ routeTree: await buildRouteTree() })
  return Object.keys(router.routesById)
}

// ADR-0007: "anything reachable in a production build that fabricates an
// authorization code would be a real vulnerability, so the gate is a test of
// its own, not a comment." This is that test, at the level that actually
// matters — the router's own route table, not just the pure decision
// function (`tests/unit/auth/mock-idp-gate.test.ts`).
describe('the mock identity provider route', () => {
  it('is registered when MSW is enabled and the auth mode is mock', async () => {
    setEnv({ VITE_ENABLE_MSW: '1', VITE_AUTH_MODE: 'mock' })
    expect(await routeIds()).toContain('/__mock-idp/authorize')
  })

  it('is NOT registered when the auth mode is oidc, even with MSW enabled', async () => {
    setEnv({ VITE_ENABLE_MSW: '1', VITE_AUTH_MODE: 'oidc' })
    expect(await routeIds()).not.toContain('/__mock-idp/authorize')
  })

  it('is NOT registered when MSW is disabled, even in mock auth mode', async () => {
    setEnv({ VITE_ENABLE_MSW: '0', VITE_AUTH_MODE: 'mock' })
    expect(await routeIds()).not.toContain('/__mock-idp/authorize')
  })

  it('is NOT registered by default (neither condition holds)', async () => {
    setEnv({ VITE_ENABLE_MSW: '0', VITE_AUTH_MODE: 'oidc' })
    expect(await routeIds()).not.toContain('/__mock-idp/authorize')
  })
})

// The messaging demo preview (`src/features/messaging/demo-route.tsx`) is a
// picture of Tchap, the La Suite messaging service kodera.io integrates —
// this repository implements no messenger. A fictional conversation reachable
// inside a customer's own console would claim a product that does not exist
// here, so its route is gated on exactly the truth table the mock identity
// provider's is, proved here at the router's own route table rather than only
// at the pure decision (`tests/unit/messaging/demo-gate.test.ts`).
describe('the messaging demo preview route', () => {
  it('is registered when MSW is enabled and the auth mode is mock', async () => {
    setEnv({ VITE_ENABLE_MSW: '1', VITE_AUTH_MODE: 'mock' })
    expect(await routeIds()).toContain('/__demo-messaging')
  })

  it('is NOT registered when the auth mode is oidc, even with MSW enabled', async () => {
    setEnv({ VITE_ENABLE_MSW: '1', VITE_AUTH_MODE: 'oidc' })
    expect(await routeIds()).not.toContain('/__demo-messaging')
  })

  it('is NOT registered when MSW is disabled, even in mock auth mode', async () => {
    setEnv({ VITE_ENABLE_MSW: '0', VITE_AUTH_MODE: 'mock' })
    expect(await routeIds()).not.toContain('/__demo-messaging')
  })

  it('is NOT registered by default (neither condition holds)', async () => {
    setEnv({ VITE_ENABLE_MSW: '0', VITE_AUTH_MODE: 'oidc' })
    expect(await routeIds()).not.toContain('/__demo-messaging')
  })
})

// console #35 review at 75deb37: the runtime gate above was not enough — the
// route object stayed statically `import`ed, so `./mock-idp-route` (and
// `../auth/mock-idp` beneath it) shipped inside every production bundle
// whether or not the gate above ever added it to the tree, because Vite
// cannot prove a runtime `if` false at build time and so cannot drop a static
// import that sits outside it. The four tests above prove the RUNTIME
// behaviour and kept passing throughout that bug. This one proves the STATIC
// shape that makes the runtime behaviour bundle-safe: `./mock-idp-route` may
// only be reached through a dynamic `import()`, guarded by the same literal
// condition it sits behind, never through a static `import … from` — that is
// what lets `scripts/check-production-bundle.sh` prove the module is absent
// from the emitted JS of an oidc build.
describe('static reachability of the mock identity provider module', () => {
  it('is reached only through a dynamic import(), never a static import', () => {
    const source = readFileSync(join(import.meta.dirname, 'routeTree.ts'), 'utf8')
    // `[^;\n]*`, not `[^;]*`: this codebase writes no semicolons (Prettier),
    // so a class that can also match a newline would run straight through
    // every line after the first `import` and find `mock-idp-route` in a
    // comment three statements later — matching a static import that was
    // never there.
    const staticImport = /^\s*import\b[^;\n]*\bmock-idp-route\b/m
    const dynamicImport = /import\(\s*['"][^'"]*mock-idp-route['"]\s*\)/
    expect(source).not.toMatch(staticImport)
    expect(source).toMatch(dynamicImport)
  })
})

// The same static shape, for the same reason, on the demo preview's module.
// The runtime tests above would keep passing if `demo-route` were statically
// `import`ed here — and every fictional message, name and channel would ship
// inside a customer's production bundle, where a reader would reasonably take
// them for a chat product this repository built.
describe('static reachability of the messaging demo module', () => {
  it('is reached only through a dynamic import(), never a static import', () => {
    const source = readFileSync(join(import.meta.dirname, 'routeTree.ts'), 'utf8')
    const staticImport = /^\s*import\b[^;\n]*\bmessaging\/demo-route\b/m
    const dynamicImport = /import\(\s*['"][^'"]*messaging\/demo-route['"]\s*\)/
    expect(source).not.toMatch(staticImport)
    expect(source).toMatch(dynamicImport)
  })
})

describe('the Espace Matrix SSO callback route', () => {
  it('sits on rootRoute outside /$org so loading /espace/callback never stores loginToken in returnTo', async () => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    const ids = await routeIds()
    expect(ids).toContain('/espace/callback')

    const router = createRouter({
      routeTree: await buildRouteTree(),
      history: createMemoryHistory({
        initialEntries: ['/espace/callback?state=test-state&loginToken=syl_never_store_me'],
      }),
    })
    await router.load()
    const matchedIds = router.state.matches.map((match) => match.routeId)
    expect(matchedIds).toContain('/espace/callback')
    expect(matchedIds).not.toContain('/$org')
    expect(window.sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
    expect(window.localStorage.length).toBe(0)
  })
})

describe('the staff plane cutover (KAD-2)', () => {
  it('never registers /staff/login in mock mode or oidc mode', async () => {
    setEnv({ VITE_ENABLE_MSW: '1', VITE_AUTH_MODE: 'mock' })
    expect(await routeIds()).not.toContain('/staff/login')

    setEnv({ VITE_ENABLE_MSW: '0', VITE_AUTH_MODE: 'oidc' })
    expect(await routeIds()).not.toContain('/staff/login')
  })

  it('carries no import of features/staff in routeTree.ts', () => {
    const source = readFileSync(join(import.meta.dirname, 'routeTree.ts'), 'utf8')
    expect(source).not.toMatch(/features\/staff/)
    expect(source).not.toMatch(/\/staff\/login/)
  })
})

// The order's pages redirect to a path while billing is off (`OrderGate`). A path the router
// matches only up to the organisation's layout renders an empty page with no 404, so the target
// must end on a route that has a screen of its own.
describe('the billing-off redirect target', () => {
  async function leaf(pathname: string) {
    const router = createRouter({
      routeTree: await buildRouteTree(),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    const matches = router.matchRoutes(pathname, {})
    const last = matches[matches.length - 1]
    return last === undefined
      ? undefined
      : router.routesById[last.routeId as keyof typeof router.routesById]
  }

  it('ends on the home screen', async () => {
    const route = await leaf(BILLING_OFF_TARGET.replace('$org', 'acme-sa'))
    expect(route?.id).toBe('/$org/home')
    expect(route?.options.component).toBeDefined()
  })

  it('would not, for the bare organisation path', async () => {
    const route = await leaf('/acme-sa')
    expect(route?.id).toBe('/$org')
  })
})

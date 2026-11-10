import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  activeScenarios,
  applyDemoParam,
  buildHandlers,
  prepareDemoScenarios,
  communityDiscoveryHandler,
} from '@/mocks/browser'
import { DEMO_SCENARIO, ORGANISATION_NAME } from '@/mocks/demo/seed'

describe('community bootstrap', () => {
  afterEach(() => sessionStorage.clear())

  it.each([
    '/',
    '/community',
    '/community/workspace',
    '/community/settings',
    '/__mock-idp/authorize?realm=community',
  ])('automatically selects community handlers for %s in mock mode', (path) => {
    sessionStorage.clear()
    prepareDemoScenarios(`https://console.test${path}`, sessionStorage, 'mock')
    expect(activeScenarios()).toEqual([DEMO_SCENARIO])
  })

  it('keeps unknown organisations and real authentication outside the demo', () => {
    sessionStorage.clear()
    prepareDemoScenarios('https://console.test/unknown-org/home', sessionStorage, 'mock')
    expect(activeScenarios()).toEqual([])
    prepareDemoScenarios('https://console.test/community/workspace', sessionStorage, 'oidc')
    expect(activeScenarios()).toEqual([])
  })

  it('preserves explicit scenarios and a demo opt-out across redirects', () => {
    sessionStorage.setItem('msw:scenarios', JSON.stringify(['shell.single-organisation']))
    prepareDemoScenarios('https://console.test/community/workspace', sessionStorage, 'mock')
    expect(activeScenarios()).toEqual(['shell.single-organisation'])
    prepareDemoScenarios('https://console.test/community/workspace?demo=0', sessionStorage, 'mock')
    prepareDemoScenarios(
      'https://console.test/__mock-idp/authorize?realm=community',
      sessionStorage,
      'mock'
    )
    expect(activeScenarios()).toEqual([])
    prepareDemoScenarios('https://console.test/community/workspace?demo=1', sessionStorage, 'mock')
    expect(activeScenarios()).toEqual([DEMO_SCENARIO])
  })
})

describe('activeScenarios', () => {
  it('is empty when sessionStorage carries nothing', () => {
    window.sessionStorage.removeItem('msw:scenarios')
    expect(activeScenarios()).toEqual([])
  })

  it('reads the JSON array useScenario writes', () => {
    window.sessionStorage.setItem('msw:scenarios', JSON.stringify(['shell.single-organisation']))
    expect(activeScenarios()).toEqual(['shell.single-organisation'])
  })

  it('is empty on malformed JSON rather than throwing during boot', () => {
    window.sessionStorage.setItem('msw:scenarios', '{not json')
    expect(activeScenarios()).toEqual([])
  })

  it('is empty when the stored value is not an array', () => {
    window.sessionStorage.setItem('msw:scenarios', JSON.stringify({ not: 'an array' }))
    expect(activeScenarios()).toEqual([])
  })

  it('drops non-string entries rather than passing them to resolveOverlays', () => {
    window.sessionStorage.setItem('msw:scenarios', JSON.stringify(['a', 42, null, 'b']))
    expect(activeScenarios()).toEqual(['a', 'b'])
  })
})

describe('buildHandlers', () => {
  // The mutation this suite must catch: an overlay silently never taking
  // effect because it was registered AFTER the generated base handler for
  // the same route. MSW resolves the first handler whose predicate matches
  // a request, so `login.single-organisation` (which answers
  // `realm: "acme-sa"` for every `/auth/discover` call, unlike the base
  // example's neutral `realm: null` since contract 0.12.0) is the sharpest
  // possible probe: if this ever regresses to appending overlays after the
  // base handlers, the base handler's `realm: null` wins and this test goes
  // red.
  const server = setupServer()
  const previousAuthMode = (import.meta.env as Record<string, unknown>)['VITE_AUTH_MODE']
  const previousKeycloak = (import.meta.env as Record<string, unknown>)['VITE_KEYCLOAK_URL']
  beforeAll(() => {
    // `oidc`, not `mock`: this suite is about overlay-versus-base-handler
    // resolution order, not the mock identity provider, and `oidc` skips
    // `authHandlers()`'s own required Keycloak env reads.
    ;(import.meta.env as Record<string, unknown>)['VITE_AUTH_MODE'] = 'oidc'
    ;(import.meta.env as Record<string, unknown>)['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
    server.listen({ onUnhandledRequest: 'error' })
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    ;(import.meta.env as Record<string, unknown>)['VITE_AUTH_MODE'] = previousAuthMode
    ;(import.meta.env as Record<string, unknown>)['VITE_KEYCLOAK_URL'] = previousKeycloak
    server.close()
  })

  it('lets a scenario overlay override the generated base handler for the same route', async () => {
    server.use(...buildHandlers(['login.single-organisation']))
    const response = await fetch('https://example.test/api/v1/auth/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ email: 'julie@acme.fr' }),
    })
    await expect(response.json()).resolves.toMatchObject({ realm: 'acme-sa', candidates: [] })
  })

  it('falls back to the generated base handler with no scenario active', async () => {
    server.use(...buildHandlers([]))
    const response = await fetch('https://example.test/api/v1/auth/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ slug: 'acme-sa' }),
    })
    await expect(response.json()).resolves.toMatchObject({ realm: null, candidates: [] })
  })

  it('activates community on discovery while leaving unknown slugs unresolved', async () => {
    let activated = false
    server.use(
      communityDiscoveryHandler(() => {
        activated = true
      }),
      ...buildHandlers([])
    )
    const discover = (slug: string) =>
      fetch('https://example.test/api/v1/auth/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ slug }),
      })
    await expect((await discover('unknown-org')).json()).resolves.toMatchObject({ realm: null })
    expect(activated).toBe(false)
    await expect((await discover('community')).json()).resolves.toMatchObject({
      realm: 'community',
    })
    expect(activated).toBe(true)
  })
})

describe('applyDemoParam', () => {
  // The entry point the demo is walked from (docs/dev/DEMO.md). It writes the
  // same session-storage key `useScenario` writes, which is what carries the
  // demo across the sign-in redirects the query parameter itself cannot
  // survive.
  function storage() {
    const written = new Map<string, string>()
    const removed: string[] = []
    return {
      written,
      removed,
      setItem: (key: string, value: string) => void written.set(key, value),
      removeItem: (key: string) => void removed.push(key),
    }
  }

  it('selects the demo scenario for ?demo=1', () => {
    const store = storage()
    applyDemoParam('https://console.test/login?demo=1', store)
    expect(store.written.get('msw:scenarios'), '?demo=1 did not start the demo').toBe(
      JSON.stringify([DEMO_SCENARIO])
    )
  })

  it('selects it for any value that is not an off switch', () => {
    for (const url of [
      'https://console.test/login?demo=',
      'https://console.test/login?demo=true',
      'https://console.test/vercelli/home?other=1&demo=yes',
    ]) {
      const store = storage()
      applyDemoParam(url, store)
      expect(store.written.get('msw:scenarios'), `${url} did not start the demo`).toBe(
        JSON.stringify([DEMO_SCENARIO])
      )
    }
  })

  it('leaves the demo on ?demo=0', () => {
    const store = storage()
    applyDemoParam('https://console.test/vercelli/home?demo=0', store)
    expect(store.removed, '?demo=0 did not clear the demo').toEqual(['msw:scenarios'])
    expect(store.written.size, '?demo=0 selected a scenario instead of clearing').toBe(0)
  })

  it('touches nothing at all when the parameter is absent', () => {
    // A spec that selected its own scenarios through `useScenario` must not
    // have them cleared by a worker start that simply had no `?demo` on the
    // URL — which a `setItem`-unconditional version of this would do.
    const store = storage()
    applyDemoParam('https://console.test/acme-sa/home', store)
    expect(store.written.size, 'a URL with no ?demo selected the demo anyway').toBe(0)
    expect(
      store.removed,
      'a URL with no ?demo cleared the scenarios a spec had already chosen'
    ).toEqual([])
  })
})

describe('the demo scenario', () => {
  const server = setupServer()
  const env = import.meta.env as Record<string, unknown>
  const previousAuthMode = env['VITE_AUTH_MODE']
  const previousKeycloak = env['VITE_KEYCLOAK_URL']
  beforeAll(() => {
    env['VITE_AUTH_MODE'] = 'oidc'
    env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
    server.listen({ onUnhandledRequest: 'error' })
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    env['VITE_AUTH_MODE'] = previousAuthMode
    env['VITE_KEYCLOAK_URL'] = previousKeycloak
    server.close()
  })

  it('answers with the seeded organisation rather than the contract example', async () => {
    // The whole chain in one assertion: the name the entry point writes, the
    // file `index-glob` discovers under it, and the seed that file serves.
    server.use(...buildHandlers([DEMO_SCENARIO]))
    const response = await fetch('https://example.test/api/v1/organisations/any-id')
    await expect(response.json()).resolves.toMatchObject({ name: ORGANISATION_NAME })
  })
})

it('bypasses only same-origin development module requests, never API calls or production requests', async () => {
  const { isDevelopmentAsset } = await import('./browser')
  for (const path of [
    '/@react-refresh',
    '/theme.js',
    '/kodera-mark-white.svg',
    '/favicon.svg',
    '/icon-512-maskable.png',
    '/developer-docs/en/api.md',
    '/@vite/client',
    '/src/main.tsx',
    '/@fs/fonts/font.woff2',
    '/node_modules/.vite/deps/react.js',
    '/@id/module',
  ]) {
    expect(
      isDevelopmentAsset(new Request(`http://localhost:5173${path}`), 'http://localhost:5173', true)
    ).toBe(true)
    expect(
      isDevelopmentAsset(
        new Request(`http://localhost:5173${path}`),
        'http://localhost:5173',
        false
      )
    ).toBe(false)
    expect(
      isDevelopmentAsset(new Request(`https://external.test${path}`), 'http://localhost:5173', true)
    ).toBe(false)
  }
  for (const path of ['/api/v1/unknown', '/@vite/unknown', '/source/main.ts', '/auth/callback']) {
    expect(
      isDevelopmentAsset(new Request(`http://localhost:5173${path}`), 'http://localhost:5173', true)
    ).toBe(false)
  }
  expect(
    isDevelopmentAsset(
      new Request('http://localhost:5173/src/main.tsx', { method: 'POST' }),
      'http://localhost:5173',
      true
    )
  ).toBe(false)
})

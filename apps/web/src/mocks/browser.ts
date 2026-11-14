// The MSW browser worker: the generated Core API handlers, the mock identity
// provider's handlers (mock auth mode only), and scenario overlays chosen at
// runtime from `sessionStorage` (docs/dev/TESTING.md §2, ADR-0005).
//
// Imported only behind a dynamic `import()` in `src/main.tsx`, itself gated
// on a literal `import.meta.env.VITE_ENABLE_MSW === '1'` check (not
// `config.mswEnabled()` — see the comment in `main.tsx` for why) — so none
// of this, the worker script and `./auth`'s handlers included, ships in a
// build that never boots MSW (`scripts/check-production-bundle.sh`).

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import { setupWorker } from 'msw/browser'
import { HttpNetworkFrame } from 'msw/experimental'
import { authMode } from '../config'
import { authHandlers } from './auth'
import { DEMO_SCENARIO, DEMO_SLUG } from './demo/seed'
import { registerInteractiveDemos } from '../app/interactiveDemo'
import { communityDemo, communityDiscovery } from './demo/community'
import { registerDemoWorkspaceCreator, registerDemoViewStorage } from '../app/interactiveDemo'
import { restoreLocalWorkspaces, registerLocalWorkspace } from './demo/localWorkspaces'
import { createLocalWorkspaceStore } from './demo/workspaceStore'
import { installDemoBranding } from './demo/branding'
import { handlers } from './generated/handlers'
import { resolveOverlays } from './overlays/index-glob'

const SCENARIO_KEY = 'msw:scenarios'

/** `?demo=1` on any URL of the app starts the walkable demo; `?demo=0` leaves
 * it (docs/dev/DEMO.md). */
const DEMO_PARAM = 'demo'
const DEMO_OFF_VALUES: readonly string[] = ['0', 'false', 'off']
const DEMO_DISABLED_KEY = 'msw:demo-disabled'

/** Fresh community visits work without a URL flag; explicit opt-out survives redirects. */
export function prepareDemoScenarios(
  url: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  mode = authMode()
): void {
  const target = new URL(url)
  const value = target.searchParams.get(DEMO_PARAM)
  if (value !== null) {
    if (DEMO_OFF_VALUES.includes(value.trim().toLowerCase()))
      storage.setItem(DEMO_DISABLED_KEY, '1')
    else storage.removeItem(DEMO_DISABLED_KEY)
    applyDemoParam(url, storage)
    return
  }
  if (mode !== 'mock' || storage.getItem(DEMO_DISABLED_KEY) === '1') return
  const community =
    target.pathname === '/' ||
    /^\/community(?:\/|$)/u.test(target.pathname) ||
    target.searchParams.get('realm') === 'community'
  if (!community) return
  // Keep explicit test scenarios: their failure cases must not become demo successes.
  if (storage.getItem(SCENARIO_KEY) !== null) return
  storage.setItem(SCENARIO_KEY, JSON.stringify([DEMO_SCENARIO]))
}

/**
 * Turns `?demo=1` into the scenario selection the worker is about to read.
 *
 * The demo has to survive the sign-in round trip — the mock identity provider
 * redirects to `/__mock-idp/authorize`, then to `/auth/callback`, then to the
 * organisation — and a query parameter does not: each of those is a full
 * document load with its own URL. So the parameter is not the state, it only
 * WRITES the state, into the same `sessionStorage` key `tests/e2e/support/
 * useScenario.ts` writes for a spec. That is also what makes the entry point a
 * URL and nothing more: no route, no button, no branch inside a screen — this
 * whole module is behind `main.tsx`'s literal `VITE_ENABLE_MSW === '1'` check
 * and is dropped from any build that never boots MSW, so the demo cannot be
 * reached from a production bundle by construction rather than by a guard
 * somebody has to remember (`scripts/check-production-bundle.sh` greps the
 * seed's own literals to keep that true).
 *
 * Anything other than an off value turns it ON, so `?demo=1`, `?demo=true` and
 * a bare `?demo=` all work: the person typing this is standing in front of a
 * customer, not reading a flag reference.
 */
export function applyDemoParam(
  url: string,
  storage: Pick<Storage, 'setItem' | 'removeItem'>
): void {
  const value = new URL(url).searchParams.get(DEMO_PARAM)
  if (value === null) return
  if (DEMO_OFF_VALUES.includes(value.trim().toLowerCase())) {
    storage.removeItem(SCENARIO_KEY)
    return
  }
  storage.setItem(SCENARIO_KEY, JSON.stringify([DEMO_SCENARIO]))
}

/**
 * The scenario names `tests/e2e/support/useScenario.ts` wrote before
 * navigation. Malformed or absent storage resolves to no scenarios rather
 * than throwing out of application boot — an end-to-end spec that meant to
 * activate one will fail on its own assertions instead, which names the
 * actual missing behaviour rather than a JSON parse error nobody asked for.
 */
export function activeScenarios(): string[] {
  const raw = window.sessionStorage.getItem(SCENARIO_KEY)
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The full handler list, in resolution order — extracted from
 * `startMockWorker` so the ORDER is something a unit test can assert on
 * without a real Service Worker (`browser.test.ts`).
 *
 * Overlays FIRST: MSW resolves the first handler whose predicate matches a
 * request, so a scenario overlay only ever takes effect if it is checked
 * before the generated base handler for the same route — appending it
 * after, as this list once did, made every overlay dead code the moment a
 * base handler already answered its path (docs/dev/TESTING.md §2).
 */
export function buildHandlers(scenarioNames: readonly string[]): HttpHandler[] {
  const overlays = resolveOverlays(scenarioNames)
  const auth = authMode() === 'mock' ? authHandlers() : []
  return [...overlays, ...auth, ...handlers]
}

/** Only the development server's own source assets bypass strict mock coverage. */
export function isDevelopmentAsset(
  request: Request,
  origin: string,
  development = import.meta.env.DEV
): boolean {
  if (!development || request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== origin) return false
  return (
    url.pathname === '/@react-refresh' ||
    url.pathname === '/@vite/client' ||
    ['/theme.js', '/favicon.svg', '/favicon.ico', '/site.webmanifest', '/llms.txt'].includes(
      url.pathname
    ) ||
    /^\/(?:icon-(?:16|32|48|180|192|512|512-maskable)\.png|kodera-(?:mark|lockup)-(?:white|slate)\.svg)$/.test(
      url.pathname
    ) ||
    url.pathname.startsWith('/developer-docs/') ||
    ['/src/', '/assets/', '/@fs/', '/node_modules/', '/@id/'].some((prefix) =>
      url.pathname.startsWith(prefix)
    )
  )
}

function registerDemoRuntime(): void {
  // The demo organisation's own mark, registered from inside the mock tree so
  // it can only ever exist where this module does (`src/app/demoBranding.ts`
  // holds the registry and the reason there is one). Before the worker starts,
  // and therefore before the first render, because `src/main.tsx` awaits this
  // call: a mark that arrived after paint would flash in.
  registerInteractiveDemos(
    activeScenarios().includes(DEMO_SCENARIO)
      ? [{ slug: DEMO_SLUG, createStore: createLocalWorkspaceStore }, communityDemo]
      : []
  )
  if (activeScenarios().includes(DEMO_SCENARIO)) {
    restoreLocalWorkspaces()
    registerDemoWorkspaceCreator(registerLocalWorkspace)
    registerDemoViewStorage({
      read(key) {
        try {
          return JSON.parse(sessionStorage.getItem(`kodera.demo.view.${key}`) ?? 'null') as unknown
        } catch {
          return undefined
        }
      },
      write(key, value) {
        try {
          sessionStorage.setItem(`kodera.demo.view.${key}`, JSON.stringify(value))
        } catch {
          /* Browser storage may be full or unavailable. */
        }
      },
    })
  }
  installDemoBranding()
}

/** Activate only a community discovery request, leaving unknown slugs to base handlers. */
export function communityDiscoveryHandler(activate: () => void): HttpHandler {
  return http.post('*/api/v1/auth/discover', async ({ request }) => {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { slug?: unknown; email?: unknown } | null
    if (
      body?.slug !== 'community' &&
      !(typeof body?.email === 'string' && body.email.endsWith('@community.kodera.io'))
    )
      return
    activate()
    return HttpResponse.json(communityDiscovery())
  })
}

export async function startMockWorker(): Promise<void> {
  prepareDemoScenarios(window.location.href, window.sessionStorage)
  registerDemoRuntime()
  const worker = setupWorker(...buildHandlers(activeScenarios()))
  if (
    authMode() === 'mock' &&
    activeScenarios().length === 0 &&
    sessionStorage.getItem(DEMO_DISABLED_KEY) !== '1'
  ) {
    worker.use(
      communityDiscoveryHandler(() => {
        sessionStorage.setItem(SCENARIO_KEY, JSON.stringify([DEMO_SCENARIO]))
        registerDemoRuntime()
        worker.use(...buildHandlers(activeScenarios()))
      })
    )
  }
  await worker.start({
    // A request MSW does not have a handler for is a mock that has drifted
    // from what the console actually calls — silently falling through to the
    // network would either hang (no such host reachable) or, worse, reach a
    // real one (docs/dev/TESTING.md).
    onUnhandledFrame({ frame, defaults }) {
      if (
        frame instanceof HttpNetworkFrame &&
        isDevelopmentAsset(frame.data.request, window.location.origin, true)
      )
        return
      defaults.error()
    },
    quiet: true,
  })
}

// The MSW browser worker: the generated Core API handlers, the mock identity
// provider's handlers (mock auth mode only), and scenario overlays chosen at
// runtime from `sessionStorage` (docs/dev/TESTING.md §2, ADR-0005).
//
// Imported only behind a dynamic `import()` in `src/main.tsx`, itself gated
// on a literal `import.meta.env.VITE_ENABLE_MSW === '1'` check (not
// `config.mswEnabled()` — see the comment in `main.tsx` for why) — so none
// of this, the worker script and `./auth`'s handlers included, ships in a
// build that never boots MSW (`scripts/check-production-bundle.sh`).

import type { HttpHandler } from 'msw'
import { setupWorker } from 'msw/browser'
import { authMode } from '../config'
import { authHandlers } from './auth'
import { DEMO_SCENARIO, DEMO_SLUG } from './demo/seed'
import { registerInteractiveDemos } from '../app/interactiveDemo'
import { communityDemo } from './demo/community'
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
    ['/src/', '/@fs/', '/node_modules/', '/@id/'].some((prefix) => url.pathname.startsWith(prefix))
  )
}

export async function startMockWorker(): Promise<void> {
  applyDemoParam(window.location.href, window.sessionStorage)
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
  const worker = setupWorker(...buildHandlers(activeScenarios()))
  await worker.start({
    // A request MSW does not have a handler for is a mock that has drifted
    // from what the console actually calls — silently falling through to the
    // network would either hang (no such host reachable) or, worse, reach a
    // real one (docs/dev/TESTING.md).
    onUnhandledRequest(request, print) {
      if (isDevelopmentAsset(request, window.location.origin)) return
      print.error()
    },
    quiet: true,
  })
}

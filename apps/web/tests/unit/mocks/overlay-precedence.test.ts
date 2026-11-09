// `src/mocks/browser.ts` composes the worker as `[...overlays, ...auth,
// ...handlers]` — overlays FIRST. MSW resolves the first handler in the
// list that returns a response (`executeHandlers` in msw's own source), the
// same "prepend wins" rule `server.use()` follows for the Node test server.
// Listing the generated base handlers first, as this file used to, made
// every browser-run overlay dead code: the base handler for a shared route
// always matched before the overlay got a turn, and only the Node test
// server's `server.use()` (which prepends on its own) ever saw the
// override. `startMockWorker` itself needs a real Service Worker and is not
// unit-testable; this proves the composition ORDER it now follows, with the
// same building blocks, against a route the generated handlers and an
// overlay both answer differently — `status-summary`'s `overall`, `degraded`
// in the generated example, `operational` in `home.default`.

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { handlers } from '@/mocks/generated/handlers'
import { resolveOverlays } from '@/mocks/overlays/index-glob'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']

describe('worker composition order', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('lets an overlay win over the generated base handler for the same route', async () => {
    server.use(...resolveOverlays(['home.default']), ...handlers)
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.overall).toBe('operational')
  })

  it('is the order that fails: base handlers first would shadow the overlay', async () => {
    // Not `startMockWorker`'s own composition — the composition it must
    // avoid, kept here so this test is provably breakable (docs/dev/
    // TESTING.md's own rule for a gate): swap the two lines above and this
    // one starts failing along with the one above passing.
    server.use(...handlers, ...resolveOverlays(['home.default']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.overall).toBe('degraded')
  })
})

// A minimal same-route conflict, independent of any real overlay, so a
// future change to `home.default` cannot make the test above pass or fail
// for the wrong reason.
describe('composition order, isolated from any real overlay', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('the first handler in the list wins when two answer the same route', async () => {
    const first = http.get('*/api/v1/__fixture', () => HttpResponse.json({ from: 'first' }))
    const second = http.get('*/api/v1/__fixture', () => HttpResponse.json({ from: 'second' }))
    server.use(first, second)
    const body = (await (await fetch('https://example.test/api/v1/__fixture')).json()) as {
      from: string
    }
    expect(body.from).toBe('first')
  })
})

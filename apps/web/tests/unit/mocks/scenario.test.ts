import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveOverlays } from '@/mocks/overlays/index-glob'

describe('resolveOverlays', () => {
  it('throws, naming the scenario, on an unknown name', () => {
    expect(() => resolveOverlays(['does-not-exist'])).toThrow('does-not-exist')
  })

  it('resolves a known scenario to its handlers', () => {
    expect(resolveOverlays(['test-fixture.first'])).toHaveLength(1)
  })

  describe('composition order', () => {
    // docs/dev/TESTING.md: overlays are discovered by file name, in the order
    // `useScenario` names them. Two overlays that both answer the same route
    // — a later scenario refining an earlier one's set-up — must not resolve
    // by array-append order (which would let the first-named scenario win
    // silently); the one named LAST is the one a test meant to take effect.
    const server = setupServer()
    beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
    afterEach(() => server.resetHandlers())
    afterAll(() => server.close())

    it('lets the scenario named last win', async () => {
      server.use(...resolveOverlays(['test-fixture.first', 'test-fixture.second']))
      const response = await fetch('https://example.test/api/v1/__scenario-composition-fixture')
      await expect(response.json()).resolves.toEqual({ overlay: 'second' })
    })

    it('is not just array order — reversing the names reverses the winner', async () => {
      server.use(...resolveOverlays(['test-fixture.second', 'test-fixture.first']))
      const response = await fetch('https://example.test/api/v1/__scenario-composition-fixture')
      await expect(response.json()).resolves.toEqual({ overlay: 'first' })
    })
  })
})

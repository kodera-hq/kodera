import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { resolveOverlays } from '@/mocks/overlays/index-glob'

describe('shell.single-organisation overlay', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('answers GET /me with exactly one organisation', async () => {
    server.use(...resolveOverlays(['shell.single-organisation']))
    const response = await fetch('https://example.test/api/v1/me')
    const body = (await response.json()) as components['schemas']['Me']
    expect(body.organisations).toHaveLength(1)
  })
})

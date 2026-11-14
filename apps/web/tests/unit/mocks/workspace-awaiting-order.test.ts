// The mock's copy of Core's gate: no workspace before an order.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { handlers } from '@/mocks/overlays/workspace.awaiting-order'

const BASE = 'https://core.test/api/v1/organisations/org-1'

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' })
  server.use(...handlers)
})
afterAll(() => server.close())

it('refuses the workspace until an order is placed, then creates it once', async () => {
  const workspace = async () =>
    ((await (await fetch(`${BASE}/workspace`)).json()) as { can_initialise: boolean })
      .can_initialise
  const initialise = () => fetch(`${BASE}/workspace/actions/initialise`, { method: 'POST' })

  expect(await workspace()).toBe(false)
  const early = await initialise()
  expect(early.status).toBe(409)
  expect(((await early.json()) as { type: string }).type).toBe(
    'https://kodera.io/problems/invalid-state-transition'
  )

  expect((await fetch(`${BASE}/orders`, { method: 'POST', body: '{}' })).status).toBe(201)
  expect(await workspace()).toBe(true)
  expect((await initialise()).status).toBe(201)
})

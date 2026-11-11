import { beforeEach, expect, it, vi } from 'vitest'
const { get, mutate } = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }))
vi.mock('../../api/client', () => ({
  coreApi: () => ({ GET: get }),
  ApiProblem: class extends Error {},
}))
vi.mock('../../api/mutations', () => ({ mutate }))
import { communitySupportHref, createCommunitySupportTicket } from './communitySupportClient'
beforeEach(() => {
  get.mockReset()
  mutate.mockReset()
})
function workspace(name = 'support') {
  return {
    organisation_id: 'community',
    state: 'initialised',
    setup: { state: 'ready', reason: null },
    can_initialise: false,
    id: 'workspace',
    categories: [],
    uncategorised_channels: [
      {
        id: 'opaque/channel',
        kind: 'text',
        name,
        template_key: 'support',
        topic: '',
        lifecycle: 'active',
        room_state: 'ready',
      },
    ],
  }
}
it('resolves the API-provided support ID instead of assuming a fixed seeded ID', async () => {
  get.mockResolvedValue({ data: workspace() })
  expect(await communitySupportHref('community-id')).toBe('/community/workspace/opaque%2Fchannel')
  expect(get).toHaveBeenCalledWith('/organisations/{organisation_id}/workspace', {
    params: { path: { organisation_id: 'community-id' } },
  })
})
it('refuses a workspace without an accessible support channel', async () => {
  get.mockResolvedValue({ data: workspace('general') })
  await expect(communitySupportHref('community-id')).rejects.toThrow('unavailable')
})
it('uses the authenticated Core mutation boundary with explicit idempotency and no guessed tenant', async () => {
  await createCommunitySupportTicket('Subject', 'Long support description', 'fr', 'request-id')
  expect(mutate).toHaveBeenCalledWith(
    { method: 'post', path: '/community/support/tickets' },
    {
      params: { header: { 'Idempotency-Key': 'request-id' } },
      body: {
        subject: 'Subject',
        body: 'Long support description',
        category: 'other',
        severity: 'question',
        locale: 'fr',
      },
    }
  )
})

import { describe, expect, it, vi } from 'vitest'
import { communitySupportPath } from './support'
const get = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', () => ({ coreApi: () => ({ GET: get }) }))
describe('community support target', () => {
  it('resolves a server-owned channel ID through the current membership', async () => {
    get
      .mockReset()
      .mockResolvedValueOnce({
        data: { organisations: [{ organisation: { id: 'org-authorized', slug: 'community' } }] },
      })
      .mockResolvedValueOnce({
        data: {
          categories: [
            {
              channels: [
                { id: 'actual-channel', kind: 'text', name: 'support', lifecycle: 'active' },
              ],
            },
          ],
          uncategorised_channels: [],
        },
      })
    expect(await communitySupportPath()).toBe('/community/workspace/actual-channel')
    expect(get).toHaveBeenLastCalledWith('/organisations/{organisation_id}/workspace', {
      params: { path: { organisation_id: 'org-authorized' } },
    })
  })
  it('does not invent a destination without membership or for an archived channel', async () => {
    get.mockReset().mockResolvedValueOnce({ data: { organisations: [] } })
    expect(await communitySupportPath()).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)
    get
      .mockReset()
      .mockResolvedValueOnce({
        data: { organisations: [{ organisation: { id: 'org-authorized', slug: 'community' } }] },
      })
      .mockResolvedValueOnce({
        data: {
          categories: [],
          uncategorised_channels: [
            { id: 'archived', kind: 'text', name: 'support', lifecycle: 'archived' },
          ],
        },
      })
    expect(await communitySupportPath()).toBeUndefined()
  })
})

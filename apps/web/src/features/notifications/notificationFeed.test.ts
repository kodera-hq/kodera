import { describe, expect, it, vi } from 'vitest'
import { NotificationFeed } from './notificationFeed'

const item = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  kind: 'mention',
  resourceId: crypto.randomUUID(),
  createdAt: '2026-11-12T09:00:00Z',
  readAt: null,
  ...overrides,
})

describe('the notification feed', () => {
  it('counts the unread ones and drops what Core should never send', async () => {
    const feed = new NotificationFeed(async () => ({
      data: [
        item(),
        item({ readAt: '2026-11-12T10:00:00Z' }),
        item({ kind: 'payment' }),
        item({ createdAt: 'never' }),
        item({ id: 4 }),
        null,
      ],
    }))
    await feed.refresh()
    expect(feed.getSnapshot()).toMatchObject({ status: 'ready', unread: 1 })
    expect(feed.getSnapshot().items).toHaveLength(2)
  })

  it('says when Core cannot be reached, keeping what it showed', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [item()] })
      .mockRejectedValueOnce(new Error('x'))
    const feed = new NotificationFeed(list)
    await feed.refresh()
    await feed.refresh()
    expect(feed.getSnapshot()).toMatchObject({ status: 'unavailable', unread: 1 })
  })

  it('marks every unread one read, and shows them unread again when Core refuses', async () => {
    const markRead = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x'))
    const unread = [item(), item()]
    const feed = new NotificationFeed(async () => ({ data: unread }), markRead)
    await feed.refresh()
    await feed.markAllRead()
    expect(markRead).toHaveBeenCalledWith(unread.map((i) => i.id))
    expect(feed.getSnapshot().unread).toBe(0)

    const again = new NotificationFeed(async () => ({ data: [item()] }), markRead)
    await again.refresh()
    await again.markAllRead()
    expect(again.getSnapshot().unread).toBe(1)
  })
})

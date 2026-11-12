// The member's notifications, as Core keeps them (Core API 0.43.0, `listNotifications`): one
// small store per page, read by the notification center with `useSyncExternalStore`. It asks
// Core when the center mounts, every minute while the page is shown, and after marking read.
// What Core returns is checked item by item; an item of an unknown kind is dropped.

import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'

export type Notification = components['schemas']['Notification']

export const NOTIFICATION_KINDS = ['mention', 'invitation', 'moderation', 'document'] as const
export const POLL_MS = 60_000
const PAGE = 50

export interface FeedSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  items: readonly Notification[]
  unread: number
}

function checked(value: unknown): Notification | null {
  if (value === null || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item['id'] !== 'string' || typeof item['resourceId'] !== 'string') return null
  if (!(NOTIFICATION_KINDS as readonly unknown[]).includes(item['kind'])) return null
  if (typeof item['createdAt'] !== 'string' || Number.isNaN(Date.parse(item['createdAt'])))
    return null
  if (item['readAt'] !== null && typeof item['readAt'] !== 'string') return null
  return item as unknown as Notification
}

type List = () => Promise<unknown>
type MarkRead = (ids: string[]) => Promise<unknown>

export class NotificationFeed {
  #snapshot: FeedSnapshot = { status: 'loading', items: [], unread: 0 }
  #listeners = new Set<() => void>()
  #list: List
  #markRead: MarkRead
  #serial = 0

  constructor(list: List = listFromCore, markRead: MarkRead = markReadInCore) {
    this.#list = list
    this.#markRead = markRead
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): FeedSnapshot => this.#snapshot

  async refresh(): Promise<void> {
    const serial = ++this.#serial
    try {
      const page = (await this.#list()) as { data?: unknown } | undefined
      if (serial !== this.#serial) return
      const items = Array.isArray(page?.data)
        ? page.data.flatMap((value) => {
            const item = checked(value)
            return item === null ? [] : [item]
          })
        : []
      this.#publish({
        status: 'ready',
        items,
        unread: items.filter((i) => i.readAt === null).length,
      })
    } catch {
      if (serial !== this.#serial) return
      this.#publish({ ...this.#snapshot, status: 'unavailable' })
    }
  }

  /** Marks every unread one read: at once on screen, then in Core; a refusal shows them again. */
  async markAllRead(now = new Date()): Promise<void> {
    const ids = this.#snapshot.items.filter((item) => item.readAt === null).map((item) => item.id)
    if (ids.length === 0) return
    const before = this.#snapshot
    this.#publish({
      status: before.status,
      items: before.items.map((item) =>
        item.readAt === null ? { ...item, readAt: now.toISOString() } : item
      ),
      unread: 0,
    })
    try {
      await this.#markRead(ids.slice(0, 200))
    } catch {
      this.#publish(before)
    }
  }

  #publish(snapshot: FeedSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

async function listFromCore(): Promise<unknown> {
  const { data } = await coreApi().GET('/notifications', { params: { query: { limit: PAGE } } })
  if (data === undefined) throw new Error('notifications-unavailable')
  return data
}

function markReadInCore(ids: string[]): Promise<unknown> {
  return mutate(
    { method: 'post', path: '/notifications/read' },
    { params: { header: { 'Idempotency-Key': crypto.randomUUID() } }, body: { ids } }
  )
}

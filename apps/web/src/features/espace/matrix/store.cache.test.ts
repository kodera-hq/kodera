// The store and the device's timeline cache, against the real matrix-js-sdk and a fake homeserver
// whose first /sync answers only when each test says.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEspaceStore, type EspaceStore } from './store'
import { memoryBackend, TimelineCache } from './timelineCache'
import type { MessageView } from './timeline'

const HS = 'https://matrix.acme.kodera.test'
const ROOM = '!general:matrix.acme.kodera.test'
const ME = '@me:matrix.acme.kodera.test'
const ALICE = '@alice:matrix.acme.kodera.test'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let ts = Date.UTC(2026, 10, 2, 9, 0)
const state = (id: string, type: string, content: Record<string, unknown>, key = '') => ({
  event_id: id,
  type,
  state_key: key,
  sender: ME,
  origin_server_ts: ts++,
  content,
})
const live = (id: string) => ({
  event_id: id,
  type: 'm.room.message',
  sender: ALICE,
  origin_server_ts: ts++,
  content: { msgtype: 'm.text', body: id },
})

function kept(id: string): MessageView {
  return {
    key: id,
    eventId: id,
    sender: ALICE,
    body: `kept ${id}`,
    ts: ts++,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

function homeserver() {
  let answer: (() => void) | null = null
  const synced = new Promise<void>((resolve) => {
    answer = resolve
  })
  let syncs = 0
  const base = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? 'GET'
    if (path === '/_matrix/client/versions') return json(200, { versions: ['v1.11'] })
    if (path === '/_matrix/client/v3/capabilities') return json(200, { capabilities: {} })
    if (path === '/_matrix/client/v3/pushrules/') return json(200, { global: {} })
    if (method === 'POST' && path === `/_matrix/client/v3/user/${ME}/filter`) {
      return json(200, { filter_id: 'f' })
    }
    if (path === '/_matrix/client/v3/sync') {
      if (++syncs === 1) {
        await synced
        return json(200, {
          next_batch: 's1',
          rooms: {
            join: {
              [ROOM]: {
                state: {
                  events: [
                    state('$create', 'm.room.create', { creator: ME, room_version: '10' }),
                    state(`$join-me`, 'm.room.member', { membership: 'join' }, ME),
                  ],
                },
                timeline: { events: [live('$live-1'), live('$live-2')], limited: false },
                unread_notifications: { notification_count: 0, highlight_count: 0 },
              },
            },
          },
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'))
        if (init?.signal?.aborted) abort()
        init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { base, answer: () => answer?.() }
}

const stores: EspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
})

function open(cache: TimelineCache, base: typeof fetch) {
  const store = createEspaceStore(
    { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
    base,
    { cache }
  )
  stores.push(store)
  return store
}

const changed = (_store: EspaceStore, test: () => boolean) =>
  vi.waitFor(() => expect(test()).toBe(true), { timeout: 4000 })

describe("the store and the device's timeline cache", () => {
  it('shows what the device kept before the first sync, then the live room in its place', async () => {
    const backend = memoryBackend()
    const before = new TimelineCache(backend, ME)
    before.save(ROOM, [kept('$kept-1'), kept('$kept-2')])
    await before.close()
    const { base, answer } = homeserver()
    const store = open(new TimelineCache(backend, ME, { delayMs: 0 }), base)
    const seen: unknown[] = []
    store.subscribe(() => seen.push(store.getSnapshot()))
    void store.start()
    await changed(store, () => store.getTimeline(ROOM).length === 2)
    expect(store.getTimeline(ROOM).map((m) => m.body)).toEqual(['kept $kept-1', 'kept $kept-2'])
    // A new snapshot: the screens read the timeline again.
    expect(seen.length).toBeGreaterThan(0)
    answer()
    await changed(store, () => store.getTimeline(ROOM)[0]?.eventId === '$live-1')
    expect(store.getTimeline(ROOM).map((m) => m.eventId)).toEqual(['$live-1', '$live-2'])
    // And the live room is what the device keeps from now on.
    await vi.waitFor(() =>
      expect(backend.records.get(`${ME}\n${ROOM}`)?.messages.map((m) => m.eventId)).toEqual([
        '$live-1',
        '$live-2',
      ])
    )
  })

  it('wipes what the device kept when the session signs out', async () => {
    const backend = memoryBackend()
    const before = new TimelineCache(backend, ME)
    before.save(ROOM, [kept('$kept-1')])
    await before.close()
    const { base } = homeserver()
    const store = open(new TimelineCache(backend, ME), base)
    void store.start()
    await changed(store, () => store.getTimeline(ROOM).length === 1)
    store.stop('signed-out')
    expect(store.getTimeline(ROOM)).toHaveLength(0)
    await vi.waitFor(() => expect(backend.records.size).toBe(0))
  })

  it('keeps nothing when told to keep nothing', async () => {
    const { base, answer } = homeserver()
    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      base,
      { cache: null }
    )
    stores.push(store)
    void store.start()
    answer()
    await changed(store, () => store.getTimeline(ROOM).length === 2)
  })
})

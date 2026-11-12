// A room's pinned messages (`m.room.pinned_events`), against the real matrix-js-sdk and a fake
// homeserver.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEspaceStore, pinnedOf, type EspaceStore } from './store'

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

function homeserver() {
  let answer: (() => void) | null = null
  const synced = new Promise<void>((resolve) => {
    answer = resolve
  })
  let syncs = 0
  const sent: unknown[] = []
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
                    state('$power', 'm.room.power_levels', {
                      users: { [ME]: 50 },
                      state_default: 50,
                      events: {},
                    }),
                    state('$pins', 'm.room.pinned_events', {
                      pinned: ['$live-1', 42, 'not-an-event', '$live-1'],
                    }),
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
    if (
      method === 'PUT' &&
      path === `/_matrix/client/v3/rooms/${ROOM}/state/m.room.pinned_events/`
    ) {
      sent.push(JSON.parse(String(init?.body)))
      return json(200, { event_id: '$pins-2' })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { base, answer: () => answer?.(), sent }
}

const stores: EspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
})

describe("a room's pinned messages", () => {
  it('reads only event ids, once each, in the order the room keeps them', () => {
    expect(pinnedOf({ pinned: ['$b', '$a', '$b', 7, 'x', null] })).toEqual(['$b', '$a'])
    expect(pinnedOf({ pinned: 'nope' })).toEqual([])
    expect(pinnedOf(undefined)).toEqual([])
  })

  it("reads the room's pins from its state, and pins one more by sending the whole list", async () => {
    const { base, answer, sent } = homeserver()
    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      base,
      { cache: null }
    )
    stores.push(store)
    void store.start()
    answer()
    await vi.waitFor(() => expect(store.getPinned(ROOM)).toEqual(['$live-1']), { timeout: 4000 })
    const first = store.getPinned(ROOM)
    expect(store.canPin(ROOM)).toBe(true)
    await store.setPinned(ROOM, '$live-2', true)
    expect(sent).toEqual([{ pinned: ['$live-1', '$live-2'] }])
    // Already pinned: nothing is sent.
    await store.setPinned(ROOM, '$live-1', true)
    expect(sent).toHaveLength(1)
    await store.setPinned(ROOM, '$live-1', false)
    expect(sent.at(-1)).toEqual({ pinned: [] })
    // The same array while the room's pins are unchanged.
    expect(store.getPinned(ROOM)).toBe(first)
  })

  it('lets no one change the pins once the store is stopped', async () => {
    const { base, answer } = homeserver()
    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      base,
      { cache: null }
    )
    stores.push(store)
    void store.start()
    answer()
    await vi.waitFor(() => expect(store.canPin(ROOM)).toBe(true), { timeout: 4000 })
    store.stop()
    expect(store.canPin(ROOM)).toBe(false)
  })
})

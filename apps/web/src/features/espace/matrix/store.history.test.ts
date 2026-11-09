// Paging back through a room's history (V1 bar M3), against the real matrix-js-sdk and a fake
// homeserver that answers /sync once and /messages as each test says.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEspaceStore, type EspaceStore, type History } from './store'

const HS = 'https://matrix.acme.kodera.test'
const ROOM = '!general:matrix.acme.kodera.test'
const ME = '@me:matrix.acme.kodera.test'
const ALICE = '@alice:matrix.acme.kodera.test'

type Event = Record<string, unknown>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let ts = Date.UTC(2026, 10, 2, 9, 0)
function message(id: string, body = id): Event {
  return {
    event_id: id,
    type: 'm.room.message',
    sender: ALICE,
    origin_server_ts: ts++,
    content: { msgtype: 'm.text', body },
  }
}
function state(id: string, type: string, content: Record<string, unknown>, key = ''): Event {
  return { event_id: id, type, state_key: key, sender: ME, origin_server_ts: ts++, content }
}
const create = state('$create', 'm.room.create', { creator: ME, room_version: '10' })
const joined = (user: string) =>
  state(`$join-${user}`, 'm.room.member', { membership: 'join' }, user)

function homeserver(timeline: Event[], messages: (from: string) => Response | Promise<Response>) {
  const asked: string[] = []
  let synced = 0
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
      if (++synced === 1) {
        return json(200, {
          next_batch: 's1',
          rooms: {
            join: {
              [ROOM]: {
                state: {
                  events: timeline.includes(create) ? [] : [create, joined(ME), joined(ALICE)],
                },
                timeline: { events: timeline, limited: true, prev_batch: 'p1' },
                unread_notifications: { notification_count: 0, highlight_count: 0 },
              },
            },
          },
        })
      }
      // Later polls wait until the store stops.
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'))
        if (init?.signal?.aborted) abort()
        init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (method === 'GET' && path === `/_matrix/client/v3/rooms/${ROOM}/messages`) {
      expect(url.searchParams.get('dir')).toBe('b')
      const from = url.searchParams.get('from') ?? ''
      asked.push(`${from} ${url.searchParams.get('limit')}`)
      return messages(from)
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { base, asked }
}

let store: EspaceStore | undefined
afterEach(() => store?.stop())

async function started(server: ReturnType<typeof homeserver>): Promise<EspaceStore> {
  store = createEspaceStore(
    { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'token' },
    server.base
  )
  await store.start()
  await vi.waitFor(() => {
    expect(store!.getSnapshot().status).toBe('live')
    expect(store!.getSnapshot().rooms).toHaveLength(1)
  })
  return store
}

const historyOf = (s: EspaceStore): History => s.getHistory(ROOM)
const bodies = (s: EspaceStore) => s.getTimeline(ROOM).map((m) => m.body)

describe('paging back through a room', () => {
  it('adds the previous page above the synced messages, and says when the start is reached', async () => {
    let answer: (response: Response) => void = () => undefined
    const server = homeserver([message('$c'), message('$d')], (from) =>
      from === 'p1'
        ? new Promise((resolve) => (answer = resolve))
        : json(200, { start: 'p2', chunk: [message('$a'), create], end: 'p3' })
    )
    const s = await started(server)
    expect(historyOf(s)).toBe('more')
    expect(bodies(s)).toEqual(['$c', '$d'])

    const loading = s.loadOlder(ROOM)
    await vi.waitFor(() => expect(historyOf(s)).toBe('loading'))
    // A second ask while the first is out is the same ask.
    await s.loadOlder(ROOM)
    expect(server.asked).toEqual(['p1 30'])

    answer(json(200, { start: 'p1', chunk: [message('$b')], end: 'p2' }))
    await loading
    await vi.waitFor(() => expect(historyOf(s)).toBe('more'))
    expect(bodies(s)).toEqual(['$b', '$c', '$d'])

    await s.loadOlder(ROOM)
    await vi.waitFor(() => expect(historyOf(s)).toBe('start'))
    expect(bodies(s)).toEqual(['$a', '$b', '$c', '$d'])
    expect(server.asked).toEqual(['p1 30', 'p2 30'])

    // At the start, nothing more is asked.
    await s.loadOlder(ROOM)
    expect(server.asked).toEqual(['p1 30', 'p2 30'])
  })

  it('says the start is reached when the homeserver has no older page', async () => {
    const server = homeserver([message('$c')], () => json(200, { start: 'p1', chunk: [] }))
    const s = await started(server)
    await s.loadOlder(ROOM)
    await vi.waitFor(() => expect(historyOf(s)).toBe('start'))
    expect(bodies(s)).toEqual(['$c'])
  })

  it('asks nothing for a room whose creation the first sync already holds', async () => {
    const server = homeserver([create, joined(ME), message('$a')], () => {
      throw new Error('not asked')
    })
    const s = await started(server)
    expect(historyOf(s)).toBe('start')
    await s.loadOlder(ROOM)
    expect(server.asked).toEqual([])
  })

  it('keeps a failed ask in the summary, with the synced messages untouched', async () => {
    const server = homeserver([message('$c')], () => json(500, { errcode: 'M_UNKNOWN' }))
    const s = await started(server)
    await s.loadOlder(ROOM)
    await vi.waitFor(() => expect(historyOf(s)).toBe('failed'))
    expect(bodies(s)).toEqual(['$c'])
  })
})

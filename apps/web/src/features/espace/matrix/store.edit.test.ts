// An edit's mentions (`m.new_content`) and a member's role from the room's power levels, against
// the real matrix-js-sdk and a fake homeserver.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEspaceStore, type EspaceStore } from './store'

const HS = 'https://matrix.acme.kodera.test'
const ROOM = '!general:matrix.acme.kodera.test'
const ME = '@me:matrix.acme.kodera.test'
const ALICE = '@alice:matrix.acme.kodera.test'
const BOB = '@bob:matrix.acme.kodera.test'
const CAROL = '@carol:matrix.acme.kodera.test'
const DAVE = '@dave:matrix.acme.kodera.test'
const EVE = '@eve:matrix.acme.kodera.test'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let ts = Date.UTC(2026, 10, 2, 9, 0)
const state = (
  id: string,
  type: string,
  content: Record<string, unknown>,
  key = '',
  sender = ME
) => ({ event_id: id, type, state_key: key, sender, origin_server_ts: ts++, content })
const join = (userId: string) =>
  state(`$join-${userId}`, 'm.room.member', { membership: 'join' }, userId, userId)
const mine = (id: string, mentions: Record<string, unknown>) => ({
  event_id: id,
  type: 'm.room.message',
  sender: ME,
  origin_server_ts: ts++,
  content: { msgtype: 'm.text', body: id, 'm.mentions': mentions },
})

/** A room created by Alice: room version 12 makes her a creator, above every power level. */
function homeserver(roomVersion: string) {
  let syncs = 0
  const sent: Record<string, unknown>[] = []
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
    if (method === 'GET' && path === `/_matrix/client/v3/profile/${ME}`) return json(200, {})
    if (path === '/_matrix/client/v3/sync') {
      if (++syncs === 1) {
        return json(200, {
          next_batch: 's1',
          rooms: {
            join: {
              [ROOM]: {
                state: {
                  events: [
                    state('$create', 'm.room.create', { room_version: roomVersion }, '', ALICE),
                    join(ALICE),
                    join(ME),
                    join(BOB),
                    join(CAROL),
                    state('$power', 'm.room.power_levels', {
                      users: { [BOB]: 50, [DAVE]: 100 },
                      users_default: 0,
                      events: {},
                    }),
                  ],
                },
                timeline: {
                  events: [mine('$named', { user_ids: [BOB] }), mine('$plain', {})],
                  limited: false,
                },
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
    if (method === 'PUT' && path.startsWith(`/_matrix/client/v3/rooms/${ROOM}/send/`)) {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return json(200, { event_id: `$sent-${sent.length}` })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { base, sent }
}

const stores: EspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
})

async function started(roomVersion = '10') {
  const { base, sent } = homeserver(roomVersion)
  const store = createEspaceStore(
    { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
    base,
    { cache: null }
  )
  stores.push(store)
  void store.start()
  await vi.waitFor(() => expect(store.getSnapshot().rooms.map((r) => r.roomId)).toContain(ROOM), {
    timeout: 4000,
  })
  return { store, sent }
}

describe('an edit names, in its new content, everyone its new text names', () => {
  it('puts the whole new m.mentions in m.new_content and only the newly named outside', async () => {
    const { store, sent } = await started()
    await store.edit(ROOM, '$named', '@Bob @Carol', {
      mentions: [BOB, CAROL, CAROL],
      mentionTargets: [
        { userId: BOB, label: 'Bob' },
        { userId: CAROL, label: 'Carol' },
      ],
    })
    expect(sent).toHaveLength(1)
    const [edit] = sent
    expect(edit).toMatchObject({
      body: '* @Bob @Carol',
      'm.mentions': { user_ids: [CAROL] },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$named' },
      'm.new_content': { body: '@Bob @Carol', 'm.mentions': { user_ids: [BOB, CAROL] } },
    })
    expect((edit?.['m.new_content'] as { formatted_body?: string }).formatted_body).toContain(
      `https://matrix.to/#/${CAROL}`
    )
  })

  it('sends an empty m.mentions when the edit removes every name, so the mention clears', async () => {
    const { store, sent } = await started()
    await store.edit(ROOM, '$named', 'plus personne')
    expect(sent[0]).toMatchObject({
      'm.mentions': { user_ids: [] },
      'm.new_content': { body: 'plus personne', 'm.mentions': { user_ids: [] } },
    })
    expect(sent[0]?.['m.mentions']).not.toHaveProperty('room')
  })

  it('names the room outside only when the message did not already', async () => {
    const { store, sent } = await started()
    await store.edit(ROOM, '$plain', '@salon', { mentionsRoom: true })
    expect(sent[0]).toMatchObject({
      'm.mentions': { user_ids: [], room: true },
      'm.new_content': { 'm.mentions': { user_ids: [], room: true } },
    })
  })

  it('carries no m.mentions when neither the message nor its edit names anyone, as send does', async () => {
    const { store, sent } = await started()
    await store.edit(ROOM, '$plain', 'toujours personne')
    expect(sent[0]).not.toHaveProperty('m.mentions')
    expect(sent[0]?.['m.new_content']).not.toHaveProperty('m.mentions')
  })
})

describe("a member's role in a room", () => {
  it('reads the loaded member level first, so a room v12 creator is an admin', async () => {
    const { store } = await started('12')
    // Alice holds `Infinity` as the creator and appears in no `users` map.
    expect(store.getMemberRole(ROOM, ALICE)).toBe('admin')
    expect(store.getMemberRole(ROOM, BOB)).toBe('admin')
    expect(store.getMemberRole(ROOM, CAROL)).toBe('member')
  })

  it('falls back to the raw power levels for a member the client has not loaded', async () => {
    const { store } = await started('12')
    expect(store.getMemberRole(ROOM, DAVE)).toBe('admin')
    expect(store.getMemberRole(ROOM, EVE)).toBe('member')
  })

  it('keeps an older room creator to the power levels it was given', async () => {
    const { store } = await started('10')
    expect(store.getMemberRole(ROOM, ALICE)).toBe('member')
    expect(store.getMemberRole(ROOM, BOB)).toBe('admin')
  })
})

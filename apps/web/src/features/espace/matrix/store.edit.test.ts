// An edit's mentions (`m.new_content`) and a member's role from the room's power levels, against
// the real matrix-js-sdk and a fake homeserver.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { editMentionCandidates, mentioning } from '../MessageComposer'
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
const join = (userId: string, displayname?: string) =>
  state(
    `$join-${userId}`,
    'm.room.member',
    displayname === undefined ? { membership: 'join' } : { membership: 'join', displayname },
    userId,
    userId
  )
const mine = (
  id: string,
  mentions: Record<string, unknown>,
  body = id,
  formattedBody?: string
) => ({
  event_id: id,
  type: 'm.room.message',
  sender: ME,
  origin_server_ts: ts++,
  content: {
    msgtype: 'm.text',
    body,
    ...(formattedBody === undefined
      ? {}
      : { format: 'org.matrix.custom.html', formatted_body: formattedBody }),
    'm.mentions': mentions,
  },
})

interface HomeserverOptions {
  roomVersion?: string
  includePowerLevels?: boolean
  additionalCreators?: readonly string[]
  names?: Readonly<Record<string, string>>
  timelineEvents?: Record<string, unknown>[]
}

/** A room created by Alice: room version 12 makes her a creator, above every power level. */
function homeserver({
  roomVersion = '10',
  includePowerLevels = true,
  additionalCreators,
  names = {},
  timelineEvents = [mine('$named', { user_ids: [BOB] }), mine('$plain', {})],
}: HomeserverOptions = {}) {
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
                    state(
                      '$create',
                      'm.room.create',
                      {
                        room_version: roomVersion,
                        ...(additionalCreators === undefined
                          ? {}
                          : { additional_creators: additionalCreators }),
                      },
                      '',
                      ALICE
                    ),
                    join(ALICE, names[ALICE]),
                    join(ME, names[ME]),
                    join(BOB, names[BOB]),
                    join(CAROL, names[CAROL]),
                    ...(includePowerLevels
                      ? [
                          state('$power', 'm.room.power_levels', {
                            users: { [BOB]: 50, [DAVE]: 100 },
                            users_default: 0,
                            events: {},
                          }),
                        ]
                      : []),
                  ],
                },
                timeline: {
                  events: timelineEvents,
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

async function started(options: string | HomeserverOptions = '10') {
  const resolved = typeof options === 'string' ? { roomVersion: options } : options
  const { base, sent } = homeserver(resolved)
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

  it('preserves a renamed member in m.new_content without re-notifying in top-level m.mentions', async () => {
    const { store, sent } = await started({
      // Bob has renamed himself to "Robert" since the original message named "@Bob".
      names: { [BOB]: 'Robert', [CAROL]: 'Carol' },
      timelineEvents: [
        mine(
          '$renamed',
          { user_ids: [BOB] },
          'ping @Bob',
          `ping <a href="https://matrix.to/#/${BOB}">@Bob</a>`
        ),
      ],
    })
    const original = store.getTimeline(ROOM).find((m) => m.eventId === '$renamed')
    const currentMembers = store
      .getMembers(ROOM)
      .filter((m): m is { userId: string; name: string } => m.name !== undefined)
      .map((m) => ({ userId: m.userId, label: m.name }))
    expect(currentMembers).toEqual([
      { userId: CAROL, label: 'Carol' },
      { userId: BOB, label: 'Robert' },
    ])

    const editedBody = 'ping @Bob!'
    const options = mentioning(
      editedBody,
      editMentionCandidates(currentMembers, undefined, original)
    )
    await store.edit(ROOM, '$renamed', editedBody, options)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      body: '* ping @Bob!',
      // Top-level delta m.mentions carries ONLY newly added users: Bob is not ghost-notified.
      'm.mentions': { user_ids: [] },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$renamed' },
      // Replacement m.new_content carries the full resolved mentions + HTML pill for @Bob.
      'm.new_content': {
        body: 'ping @Bob!',
        'm.mentions': { user_ids: [BOB] },
      },
    })
    expect((sent[0]?.['m.new_content'] as { formatted_body?: string }).formatted_body).toContain(
      `<a href="https://matrix.to/#/${BOB}">@Bob</a>!`
    )
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

  it('treats a room v12 creator and additional_creators as admin even when no m.room.power_levels event exists', async () => {
    const { store } = await started({
      roomVersion: '12',
      includePowerLevels: false,
      additionalCreators: [CAROL, EVE],
    })
    // Without m.room.power_levels, matrix-js-sdk leaves member.powerLevel at numeric 0.
    expect(store.getMemberRole(ROOM, ALICE)).toBe('admin')
    expect(store.getMemberRole(ROOM, CAROL)).toBe('admin')
    expect(store.getMemberRole(ROOM, EVE)).toBe('admin')
    expect(store.getMemberRole(ROOM, BOB)).toBe('member')
    expect(store.getMemberRole(ROOM, DAVE)).toBe('member')
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
    const { store: withoutPowerLevels } = await started({
      roomVersion: '10',
      includePowerLevels: false,
      additionalCreators: [CAROL],
    })
    expect(withoutPowerLevels.getMemberRole(ROOM, ALICE)).toBe('member')
    expect(withoutPowerLevels.getMemberRole(ROOM, CAROL)).toBe('member')
  })
})

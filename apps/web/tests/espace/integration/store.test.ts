// Espace's store against a real Synapse (docs/dev/ESPACE_STACK.md): two members, each with
// their own client and /sync, as two browsers would be. What one does, the other's snapshot
// shows. Timeline bugs never show against a mock, which is why this file exists.

import { randomUUID } from 'node:crypto'
import { MsgType } from 'matrix-js-sdk'
import { logger } from 'matrix-js-sdk/lib/logger.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EspaceStore, matrixClientForTests, type RoomSummary } from '@/features/espace/matrix/store'
import { eventually, member, signInAgain } from './stack'

// The SDK logs every sync step; a failing test's own message is what matters here. Its logger
// is a loglevel one, typed without the method that silences it.
;(logger as unknown as { setLevel: (level: 'silent') => void }).setLevel('silent')

let alice: EspaceStore
let bob: EspaceStore
let aliceId: string
let bobId: string
let roomId: string

const summary = (store: EspaceStore, id: string): RoomSummary | undefined =>
  store.getSnapshot().rooms.find((candidate) => candidate.roomId === id)
const last = (store: EspaceStore, id: string) => store.getTimeline(id).at(-1)

beforeAll(async () => {
  const [a, b] = await Promise.all([member('alice'), member('bob')])
  aliceId = a.userId
  bobId = b.userId
  alice = new EspaceStore(a)
  bob = new EspaceStore(b)
  await Promise.all([alice.start(), bob.start()])
  await eventually(alice, (s) => expect(s.status).toBe('live'))
  await eventually(bob, (s) => expect(s.status).toBe('live'))
  // The tenant agent creates channels (design §2.1); here Alice plays it.
  const created = await matrixClientForTests(alice).createRoom({ name: 'général', invite: [bobId] })
  roomId = created.room_id
})

afterAll(() => {
  alice?.stop()
  bob?.stop()
})

describe('a text channel between two members', () => {
  it('offers the invitation, then the channel once joined, as a text channel', async () => {
    await eventually(bob, (s) =>
      expect(s.invites).toContainEqual({ roomId, name: 'général', inviter: aliceId })
    )
    await bob.join(roomId)
    await eventually(bob, (s) => {
      expect(s.invites.map((i) => i.roomId)).not.toContain(roomId)
      expect(summary(bob, roomId)).toMatchObject({ name: 'général', kind: 'text' })
    })
  })

  it("delivers a message to the other member, and marks it sent on the sender's side", async () => {
    await alice.send(roomId, 'bonjour Bob')
    await eventually(bob, () =>
      expect(last(bob, roomId)).toMatchObject({ body: 'bonjour Bob', sender: aliceId })
    )
    await eventually(alice, () =>
      expect(last(alice, roomId)).toMatchObject({ body: 'bonjour Bob', delivery: 'sent' })
    )
  })

  it('keeps unchanged messages as the same objects when a new message arrives', async () => {
    const before = bob.getTimeline(roomId)
    await alice.send(roomId, 'encore un')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('encore un'))
    const after = bob.getTimeline(roomId)
    expect(after).not.toBe(before)
    for (const [index, message] of before.entries()) expect(after[index]).toBe(message)
  })

  it('counts an unread message, and clears the count once read', async () => {
    await alice.send(roomId, 'tu as vu ?')
    // Read once the message itself has arrived: an earlier one already made the count non-zero.
    await eventually(bob, () => {
      expect(last(bob, roomId)!.body).toBe('tu as vu ?')
      expect(summary(bob, roomId)!.unread).toBeGreaterThan(0)
    })
    await bob.markRead(roomId)
    await eventually(bob, () => expect(summary(bob, roomId)!.unread).toBe(0))
  })

  it('counts a mention apart from the other unread messages', async () => {
    await alice.send(roomId, 'Bob, un instant', { mentions: [bobId] })
    await eventually(bob, () => expect(summary(bob, roomId)!.mentions).toBeGreaterThan(0))
  })

  it('replaces an edited message in place, for the other member too', async () => {
    await alice.send(roomId, 'réunion à 10 h')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('réunion à 10 h'))
    const original = last(bob, roomId)!.eventId
    await alice.edit(roomId, original, 'réunion à 11 h')
    await eventually(bob, () => {
      const edited = bob.getTimeline(roomId).find((m) => m.eventId === original)
      expect(edited).toMatchObject({ body: 'réunion à 11 h', edited: true })
      // The edit is folded into its message, not shown as a second one.
      expect(bob.getTimeline(roomId).filter((m) => m.body.includes('11 h'))).toHaveLength(1)
    })
  })

  it("counts a reaction on both sides, marked as the reacting member's own", async () => {
    await alice.send(roomId, 'on déjeune ensemble ?')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('on déjeune ensemble ?'))
    const target = last(bob, roomId)!.eventId
    await bob.react(roomId, target, '👍')
    await eventually(alice, () =>
      expect(alice.getTimeline(roomId).find((m) => m.eventId === target)!.reactions).toEqual([
        { key: '👍', count: 1, mine: false },
      ])
    )
    await eventually(bob, () =>
      expect(bob.getTimeline(roomId).find((m) => m.eventId === target)!.reactions).toEqual([
        { key: '👍', count: 1, mine: true },
      ])
    )
  })

  it('empties a deleted message for the other member', async () => {
    await alice.send(roomId, 'message à retirer')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('message à retirer'))
    const target = last(bob, roomId)!.eventId
    await alice.remove(roomId, target)
    await eventually(bob, () =>
      expect(bob.getTimeline(roomId).find((m) => m.eventId === target)).toMatchObject({
        body: '',
        redacted: true,
      })
    )
  })

  it('adds no deleted message when an edit or a thread reply is deleted', async () => {
    const client = matrixClientForTests(alice)
    await alice.send(roomId, 'racine')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('racine'))
    const root = last(bob, roomId)!.eventId
    const before = bob.getTimeline(roomId).length
    const reply = await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: 'dans le fil',
      'm.relates_to': { rel_type: 'm.thread', event_id: root },
    } as never)
    const edit = await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: '* racine modifiée',
      'm.new_content': { msgtype: 'm.text', body: 'racine modifiée' },
      'm.relates_to': { rel_type: 'm.replace', event_id: root },
    } as never)
    await eventually(bob, () =>
      expect(bob.getTimeline(roomId).find((m) => m.eventId === root)!.body).toBe('racine modifiée')
    )
    await alice.remove(roomId, reply.event_id)
    await alice.remove(roomId, edit.event_id)
    await alice.send(roomId, 'après')
    await eventually(bob, () => expect(last(bob, roomId)!.body).toBe('après'))
    // The two deletions added nothing: only « après » is new, and the edit is undone.
    expect(bob.getTimeline(roomId)).toHaveLength(before + 1)
    expect(bob.getTimeline(roomId).find((m) => m.eventId === root)!.body).toBe('racine')
  })
})

describe('an audio room', () => {
  it('reads the room as audio, and who is inside, from its state; and follows a change', async () => {
    const created = await matrixClientForTests(alice).createRoom({
      name: 'lounge',
      invite: [bobId],
      initial_state: [
        {
          type: 'io.kodera.room.policy',
          state_key: '',
          content: { kind: 'audio', listen_only: false },
        },
        {
          type: 'io.kodera.room.occupancy',
          state_key: '',
          content: {
            version: 1,
            participants: [{ user_id: aliceId, devices: 1, screen_share: false, camera: false }],
            at_ms: 1,
          },
        },
      ],
    })
    const audio = created.room_id
    await eventually(bob, (s) => expect(s.invites.map((i) => i.roomId)).toContain(audio))
    await bob.join(audio)
    await eventually(bob, () =>
      expect(summary(bob, audio)).toMatchObject({
        kind: 'audio',
        occupancy: { participants: [aliceId], screenShare: [] },
      })
    )
    // The room-access service rewrites the state as people come and go (design §2.2), in its
    // own schema (Core docs/specs/ESPACE_STRUCTURE.md §12).
    await matrixClientForTests(alice).sendStateEvent(
      audio,
      'io.kodera.room.occupancy' as never,
      {
        version: 1,
        participants: [
          { user_id: aliceId, devices: 1, screen_share: true, camera: false },
          { user_id: bobId, devices: 2, screen_share: false, camera: false },
        ],
        at_ms: 2,
      } as never,
      ''
    )
    await eventually(bob, () =>
      expect(summary(bob, audio)!.occupancy).toEqual({
        participants: [aliceId, bobId],
        screenShare: [aliceId],
      })
    )
  })
})

describe("a channel's room", () => {
  it('is found by its alias in the directory, and a channel without one is not ready', async () => {
    // The tenant agent names each channel's room by alias at creation (Core contract 0.25.2);
    // here Alice plays it, under a name that is not the channel's.
    const channel = randomUUID()
    const missing = randomUUID()
    const created = await matrixClientForTests(alice).createRoom({
      name: 'nom sans rapport',
      room_alias_name: `kodera-ch-${channel}`,
      invite: [bobId],
    })
    await bob.resolveChannels([channel, missing])
    expect(bob.getSnapshot().channels.get(channel)).toEqual({
      state: 'resolved',
      roomId: created.room_id,
    })
    expect(bob.getSnapshot().channels.get(missing)).toEqual({ state: 'pending' })
  })
})

describe("a channel's header, as a member opening the workspace sees it", () => {
  it('shows the faces of members who never wrote, once their member list loads', async () => {
    // Staging's #général: four members, and only the one looking has written. The joins are older
    // than the first sync's 50 events, so that sync lazy-loads none of the other members.
    const [c, d, e] = await Promise.all([member('carol'), member('dan'), member('eve')])
    const [carol, dan, eve] = [new EspaceStore(c), new EspaceStore(d), new EspaceStore(e)]
    try {
      await Promise.all([carol.start(), dan.start(), eve.start()])
      const created = await matrixClientForTests(carol).createRoom({
        name: 'général',
        invite: [d.userId, e.userId],
      })
      const room = created.room_id
      await eventually(dan, (s) => expect(s.invites.map((i) => i.roomId)).toContain(room))
      await eventually(eve, (s) => expect(s.invites.map((i) => i.roomId)).toContain(room))
      await Promise.all([dan.join(room), eve.join(room)])
      await eventually(carol, () => expect(summary(carol, room)?.joined).toBe(3))
      // Each one answered by the homeserver before the next: the store's own sends go out at
      // once, and stopping it drops those still on their way.
      const client = matrixClientForTests(carol)
      for (let index = 0; index < 55; index += 1)
        await client.sendMessage(room, { msgtype: MsgType.Text, body: `message ${index}` })
    } finally {
      carol.stop()
      dan.stop()
      eve.stop()
    }

    // Carol opens the workspace again, from a new device: a first sync of her own.
    const opened = new EspaceStore(await signInAgain(c))
    try {
      await opened.start()
      await eventually(opened, (s) => expect(s.status).toBe('live'))
      const room = opened.getSnapshot().rooms.find((r) => r.name === 'général')!.roomId
      await eventually(opened, () => expect(summary(opened, room)?.joined).toBe(3))
      // The first sync brought none of the others: only the member list can name them.
      expect(summary(opened, room)?.faces).toEqual([])
      // What the header asks for when it shows fewer faces than the people it counts.
      opened.loadMembers(room)
      await eventually(opened, () =>
        expect(
          summary(opened, room)
            ?.faces?.map((face) => face.userId)
            .sort()
        ).toEqual([d.userId, e.userId].sort())
      )
      // The homeserver gave both their localpart for a name, an id no one reads: no name, so the
      // header draws a person glyph rather than the id's first character (« 9 » on staging).
      expect(summary(opened, room)?.faces?.map((face) => face.name)).toEqual([undefined, undefined])
    } finally {
      opened.stop()
    }
  })
})

describe('the session', () => {
  it('buys a new token from Synapse when the old one is refused, and carries on', async () => {
    const session = await member('carol')
    let refused = false
    // Synapse would refuse the first token after five minutes; here, at the first /sync.
    const base: typeof fetch = async (input, init) => {
      const token = new Headers(init?.headers).get('Authorization')
      if (
        !refused &&
        token === `Bearer ${session.accessToken}` &&
        String(input).includes('/sync')
      ) {
        refused = true
        return new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', soft_logout: true }), {
          status: 401,
        })
      }
      return fetch(input, init)
    }
    const carol = new EspaceStore(session, base)
    try {
      await carol.start()
      await eventually(carol, (s) => expect(s.status).toBe('live'))
      expect(refused).toBe(true)
      expect(matrixClientForTests(carol).getAccessToken()).not.toBe(session.accessToken)
      // The new token works: Carol can create a room and write in it.
      const { room_id } = await matrixClientForTests(carol).createRoom({ name: 'carnet' })
      await carol.send(room_id, 'toujours là')
      await eventually(carol, () => expect(last(carol, room_id)?.delivery).toBe('sent'))
    } finally {
      carol.stop()
    }
  })

  it('stopped once live, ends its sync', async () => {
    const session = await member('erin')
    let syncs = 0
    const base: typeof fetch = (input, init) => {
      if (String(input).includes('/sync')) syncs += 1
      return fetch(input, init)
    }
    const erin = new EspaceStore(session, base)
    await erin.start()
    await eventually(erin, (s) => expect(s.status).toBe('live'))
    erin.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settled = syncs
    // A running sync answers an invitation and polls again; a stopped one never does.
    await matrixClientForTests(alice).createRoom({ name: 'réveil', invite: [session.userId] })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(syncs).toBe(settled)
    expect(erin.getSnapshot().status).toBe('stopped')
  })

  it('stopped just after start returns, before the first /sync answers, halts cleanly', async () => {
    const session = await member('fred')
    let syncs = 0
    const base: typeof fetch = (input, init) => {
      if (String(input).includes('/sync')) syncs += 1
      return fetch(input, init)
    }
    const fred = new EspaceStore(session, base)
    await fred.start()
    // startClient has returned; push rules, the filter and the first /sync are still on their way.
    fred.stop()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const settled = syncs
    await matrixClientForTests(alice).createRoom({ name: 'réveil', invite: [session.userId] })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(syncs).toBe(settled)
    expect(fred.getSnapshot().status).toBe('stopped')
  })

  it('stopped while starting, as React does with an effect, leaves no sync running', async () => {
    const session = await member('dave')
    let syncs = 0
    const base: typeof fetch = (input, init) => {
      if (String(input).includes('/sync')) syncs += 1
      return fetch(input, init)
    }
    const dave = new EspaceStore(session, base)
    const starting = dave.start()
    dave.stop()
    await starting
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const settled = syncs
    await matrixClientForTests(alice).createRoom({ name: 'réveil', invite: [session.userId] })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(syncs).toBe(settled)
    expect(dave.getSnapshot().status).toBe('stopped')
    await expect(dave.start()).rejects.toThrow('stopped')
  })
})

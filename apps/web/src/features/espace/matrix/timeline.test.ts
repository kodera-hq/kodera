import { describe, expect, it } from 'vitest'
import { occupancyOf, threadView, timelineView, type RawEvent } from './timeline'

const ME = '@alice:kodera.test'
const BOB = '@bob:kodera.test'

let ts = 1_000
function event(partial: Partial<RawEvent> & Pick<RawEvent, 'event_id'>): RawEvent {
  ts += 1
  return { type: 'm.room.message', sender: ME, origin_server_ts: ts, content: {}, ...partial }
}
const message = (id: string, body: string, sender = ME, extra: Record<string, unknown> = {}) =>
  event({ event_id: id, sender, content: { msgtype: 'm.text', body, ...extra } })
const edit = (id: string, target: string, body: string, sender = ME) =>
  event({
    event_id: id,
    sender,
    content: {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    },
  })
const reaction = (id: string, target: string, key: string, sender: string) =>
  event({
    event_id: id,
    type: 'm.reaction',
    sender,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } },
  })

describe('the timeline Espace draws', () => {
  it('lists messages oldest first, and leaves other events out', () => {
    const view = timelineView(
      [
        event({ event_id: '$create', type: 'm.room.create', content: {} }),
        message('$1', 'bonjour'),
        message('$2', 'salut', BOB),
      ],
      ME
    )
    expect(view.map((m) => [m.eventId, m.sender, m.body])).toEqual([
      ['$1', ME, 'bonjour'],
      ['$2', BOB, 'salut'],
    ])
  })

  it('shows the latest edit in place of the text, and says it was edited', () => {
    const view = timelineView(
      [
        message('$1', 'bonjour'),
        edit('$e1', '$1', 'bonjour à tous'),
        edit('$e2', '$1', 'bonjour à toutes'),
      ],
      ME
    )
    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({ body: 'bonjour à toutes', edited: true })
  })

  it('ignores an edit from someone other than the message’s sender', () => {
    const view = timelineView([message('$1', 'bonjour'), edit('$e', '$1', 'piraté', BOB)], ME)
    expect(view[0]).toMatchObject({ body: 'bonjour', edited: false })
  })

  it('empties a deleted message for everyone, edits and reactions included', () => {
    const view = timelineView(
      [
        event({ event_id: '$1', content: {}, unsigned: { redacted_because: { sender: ME } } }),
        edit('$e', '$1', 'trop tard'),
        reaction('$r', '$1', '👍', BOB),
      ],
      ME
    )
    expect(view[0]).toMatchObject({ body: '', redacted: true, edited: false, reactions: [] })
  })

  it('no longer applies an edit that was itself deleted', () => {
    const view = timelineView(
      [
        message('$1', 'bonjour'),
        event({ ...edit('$e', '$1', 'retiré'), unsigned: { redacted_because: {} } }),
      ],
      ME
    )
    expect(view[0]).toMatchObject({ body: 'bonjour', edited: false })
  })

  it('counts reactions per key, once per person, and marks mine', () => {
    const view = timelineView(
      [
        message('$1', 'bonjour', BOB),
        reaction('$r1', '$1', '👍', ME),
        reaction('$r2', '$1', '👍', BOB),
        reaction('$r3', '$1', '👍', BOB),
        reaction('$r4', '$1', '🎉', BOB),
      ],
      ME
    )
    expect(view[0]!.reactions).toEqual([
      { key: '👍', count: 2, mine: true },
      { key: '🎉', count: 1, mine: false },
    ])
  })

  it('keeps a reply’s target, and leaves thread replies to their thread', () => {
    const view = timelineView(
      [
        message('$1', 'question'),
        message('$2', 'réponse', BOB, { 'm.relates_to': { 'm.in_reply_to': { event_id: '$1' } } }),
        message('$3', 'dans le fil', BOB, {
          'm.relates_to': { rel_type: 'm.thread', event_id: '$1' },
        }),
      ],
      ME
    )
    expect(view.map((m) => [m.eventId, m.replyTo])).toEqual([
      ['$1', null],
      ['$2', '$1'],
    ])
  })

  it('keeps a row’s key across sending, and says how far each message got', () => {
    const view = timelineView(
      [
        { ...message('$1', 'envoyé'), key: 'txn-1' },
        { ...message('~txn-2', 'en route'), key: 'txn-2', local: 'pending' },
        { ...message('~txn-3', 'refusé'), key: 'txn-3', local: 'failed' },
        message('$4', 'reçu', BOB),
      ],
      ME
    )
    expect(view.map((m) => [m.key, m.delivery])).toEqual([
      ['txn-1', 'sent'],
      ['txn-2', 'pending'],
      ['txn-3', 'failed'],
      ['$4', 'sent'],
    ])
  })

  it('shows a deleted event whose relation was never seen as a deleted message', () => {
    const view = timelineView(
      [
        message('$1', 'bonjour'),
        event({ event_id: '$2', content: {}, unsigned: { redacted_because: {} } }),
      ],
      ME
    )
    expect(view.map((m) => [m.eventId, m.redacted])).toEqual([
      ['$1', false],
      ['$2', true],
    ])
  })

  it('keeps a deleted thread reply out of the main timeline when its relation is known', () => {
    const view = timelineView(
      [
        message('$1', 'question'),
        event({
          event_id: '$2',
          content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$1' } },
          unsigned: { redacted_because: {} },
        }),
      ],
      ME
    )
    expect(view.map((m) => m.eventId)).toEqual(['$1'])
  })

  it('builds a thread’s replies in order, applying edits and reactions inside the thread', () => {
    const events = [
      message('$root', 'sujet principal'),
      message('$other', 'autre racine'),
      message('$t1', 'première réponse', BOB, {
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      }),
      message('$t2', 'réponse autre fil', ME, {
        'm.relates_to': { rel_type: 'm.thread', event_id: '$other' },
      }),
      message('$t3', 'deuxième réponse', ME, {
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      }),
      edit('$e1', '$t1', 'première réponse corrigée', BOB),
      reaction('$r1', '$t3', '👍', BOB),
    ]
    const replies = threadView(events, '$root', ME)
    expect(replies.map((m) => [m.eventId, m.sender, m.body, m.edited])).toEqual([
      ['$t1', BOB, 'première réponse corrigée', true],
      ['$t3', ME, 'deuxième réponse', false],
    ])
    expect(replies[1]!.reactions).toEqual([{ key: '👍', count: 1, mine: false }])
  })
})

describe('who is in an audio room', () => {
  // The room-access service's own shape (kodera-core `room_access/`): one entry per member, with
  // how many of their devices are in the call and what they share.
  const entry = (user_id: string, extra: Record<string, unknown> = {}) => ({
    user_id,
    devices: 1,
    screen_share: false,
    camera: false,
    ...extra,
  })

  it("reads the participants and the screen shares from the producer's entries", () => {
    expect(
      occupancyOf({
        version: 1,
        participants: [entry(ME), entry(BOB, { devices: 2, screen_share: true })],
        at_ms: 1_761_000_000_000,
      })
    ).toEqual({ participants: [ME, BOB], screenShare: [BOB] })
    expect(occupancyOf({ version: 1, participants: [], at_ms: 1 })).toEqual({
      participants: [],
      screenShare: [],
    })
  })

  it('tolerates fields it does not know, at the top and in an entry', () => {
    expect(
      occupancyOf({
        version: 1,
        participants: [entry(BOB, { screen_share: true, hand_raised: true })],
        at_ms: 1,
        region: 'fr-par',
      })
    ).toEqual({ participants: [BOB], screenShare: [BOB] })
  })

  it('drops a malformed entry and keeps the others, rather than crash or guess', () => {
    expect(
      occupancyOf({
        version: 1,
        participants: [
          'x',
          null,
          ME,
          {},
          entry('bob'),
          entry(42 as unknown as string),
          entry(BOB, { screen_share: 'yes' }),
          entry(BOB, { devices: -1 }),
          entry(BOB, { devices: 1.5 }),
          entry(BOB, { camera: 1 }),
          entry(ME),
          entry(ME),
        ],
        at_ms: 1,
      })
    ).toEqual({ participants: [ME], screenShare: [] })
  })

  it('counts only those in the call on at least one device', () => {
    const { devices: _devices, ...noCount } = entry(BOB)
    expect(
      occupancyOf({
        version: 1,
        participants: [entry(BOB, { devices: 0, screen_share: true }), noCount, entry(ME)],
        at_ms: 1,
      })
    ).toEqual({ participants: [ME], screenShare: [] })
  })

  it('reads nothing from content of another shape or version', () => {
    for (const content of [
      undefined,
      null,
      'x',
      {},
      { version: 1 },
      { version: 1, participants: 'x' },
      { version: 1, participants: {} },
      { version: 2, participants: [entry(ME)] },
      { participants: [entry(ME)] },
      // The Console's former, wrong reading of the event.
      { participants: [ME, BOB], screen_share: [BOB] },
    ]) {
      expect(occupancyOf(content)).toBeNull()
    }
  })
})

describe('a message that mentions the viewer (M8)', () => {
  const redaction = { redacted_because: { event_id: '$r' } }

  it("is another member's message naming the viewer in `m.mentions.user_ids`", () => {
    const view = timelineView(
      [
        message('$named', '@Alice ?', BOB, { 'm.mentions': { user_ids: [BOB, ME] } }),
        message('$other', '@Carol ?', BOB, { 'm.mentions': { user_ids: ['@carol:kodera.test'] } }),
        message('$text', 'Alice, tu es là ?', BOB),
        message('$malformed', '@Alice', BOB, { 'm.mentions': { user_ids: ME } }),
        message('$own', '@Alice', ME, { 'm.mentions': { user_ids: [ME] } }),
        event({
          event_id: '$gone',
          sender: BOB,
          content: { 'm.mentions': { user_ids: [ME] } },
          unsigned: redaction,
        }),
      ],
      ME
    )
    expect(view.filter((m) => m.mentionsMe === true).map((m) => m.eventId)).toEqual(['$named'])
    expect(view.find((m) => m.eventId === '$text')).not.toHaveProperty('mentionsMe')
  })
})

it('exposes attachment names for file browsing without trusting download URLs', () => {
  const file = event({
    event_id: '$file',
    content: { msgtype: 'm.file', body: 'review.pdf', url: 'javascript:alert(1)' },
  })
  expect(timelineView([file], ME)[0]?.attachment).toEqual({ name: 'review.pdf' })
  expect(
    timelineView([{ ...file, unsigned: { redacted_because: {} } }], ME)[0]?.attachment
  ).toBeUndefined()
  expect(timelineView([message('$text', 'review.pdf')], ME)[0]?.attachment).toBeUndefined()
})

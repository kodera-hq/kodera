import { describe, expect, it } from 'vitest'
import { calendarDay } from '../../i18n/format'
import type { MessageView } from './matrix/timeline'
import { NEW_MESSAGES_KEY, quarterHourDays, timelineRows } from './timelineRows'

const ME = '@me:acme-sa.kodera.test'
const ALICE = '@alice:acme-sa.kodera.test'

function message(eventId: string, iso: string, patch: Partial<MessageView> = {}): MessageView {
  return {
    key: eventId,
    eventId,
    sender: ALICE,
    body: eventId,
    ts: Date.parse(iso),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...patch,
  }
}

/** The rows as short labels: `day:YYYY-MM-DD`, `new`, or the message's event id. `unreadFrom` is the
 * first message after the read marker. */
function shape(messages: MessageView[], unreadFrom: string | null = null) {
  return timelineRows(messages, { dayOf: calendarDay, unreadFrom, me: ME }).map((row) =>
    row.kind === 'day' ? `day:${row.day}` : row.kind === 'new' ? 'new' : row.message.eventId
  )
}

describe('the day dividers', () => {
  it('opens the log with the first message’s day, and adds one where the day changes', () => {
    expect(
      shape([
        message('$a', '2026-11-04T08:00:00Z'),
        message('$b', '2026-11-04T16:00:00Z'),
        message('$c', '2026-11-05T08:00:00Z'),
      ])
    ).toEqual(['day:2026-11-04', '$a', '$b', 'day:2026-11-05', '$c'])
  })

  it('takes the day from Paris time: 23:30 UTC in winter is already the next day', () => {
    expect(
      shape([message('$a', '2026-11-04T22:30:00Z'), message('$b', '2026-11-04T23:30:00Z')])
    ).toEqual(['day:2026-11-04', '$a', 'day:2026-11-05', '$b'])
  })

  it('never opens a day twice: a message stamped earlier stays under the current day', () => {
    expect(
      shape([
        message('$a', '2026-11-04T20:00:00Z'),
        message('$b', '2026-11-04T23:00:30Z'),
        message('$echo', '2026-11-04T22:59:45Z', { delivery: 'pending' }),
      ])
    ).toEqual(['day:2026-11-04', '$a', 'day:2026-11-05', '$b', '$echo'])
  })

  it('draws nothing for an empty log', () => {
    expect(shape([])).toEqual([])
  })

  it('keys each divider by its day, so a row keeps its identity as older messages load', () => {
    const rows = timelineRows([message('$a', '2026-11-04T08:00:00Z')], {
      dayOf: calendarDay,
      unreadFrom: null,
      me: ME,
    })
    expect(rows[0]).toEqual({
      kind: 'day',
      key: 'day-2026-11-04',
      day: '2026-11-04',
      ts: Date.parse('2026-11-04T08:00:00Z'),
    })
  })
})

describe('« Nouveaux messages »', () => {
  const day = '2026-11-05T'

  it('goes above the first unread message', () => {
    expect(
      shape(
        [
          message('$a', `${day}08:00:00Z`),
          message('$b', `${day}08:10:00Z`),
          message('$c', `${day}08:20:00Z`),
        ],
        '$b'
      )
    ).toEqual(['day:2026-11-05', '$a', 'new', '$b', '$c'])
  })

  it('skips the member’s own messages among the unread ones', () => {
    expect(
      shape(
        [
          message('$a', `${day}08:00:00Z`),
          message('$mine', `${day}08:05:00Z`, { sender: ME }),
          message('$b', `${day}08:10:00Z`),
        ],
        '$mine'
      )
    ).toEqual(['day:2026-11-05', '$a', '$mine', 'new', '$b'])
  })

  it('is not drawn when only the member wrote since the marker', () => {
    expect(
      shape(
        [message('$a', `${day}08:00:00Z`), message('$mine', `${day}08:05:00Z`, { sender: ME })],
        '$mine'
      )
    ).not.toContain('new')
  })

  it('is not drawn when nothing follows the read marker', () => {
    expect(
      shape([message('$a', `${day}08:00:00Z`), message('$b', `${day}08:10:00Z`)], null)
    ).not.toContain('new')
  })

  it('is not drawn for a room never read, which would mark its whole history', () => {
    expect(shape([message('$a', `${day}08:00:00Z`)], null)).not.toContain('new')
  })

  it('is not drawn when the first unread message is not in the loaded timeline', () => {
    expect(shape([message('$b', `${day}08:10:00Z`)], '$gone')).not.toContain('new')
  })

  it('never marks a message the server does not have yet', () => {
    expect(
      shape(
        [
          message('$a', `${day}08:00:00Z`),
          message('$pending', `${day}08:05:00Z`, { delivery: 'pending' }),
          message('$b', `${day}08:10:00Z`),
        ],
        '$pending'
      )
    ).toEqual(['day:2026-11-05', '$a', '$pending', 'new', '$b'])
  })

  it('never marks a deleted message', () => {
    expect(
      shape(
        [
          message('$a', `${day}08:00:00Z`),
          message('$gone', `${day}08:05:00Z`, { redacted: true }),
          message('$b', `${day}08:10:00Z`),
        ],
        '$gone'
      )
    ).toEqual(['day:2026-11-05', '$a', '$gone', 'new', '$b'])
  })

  it('comes after the day divider when the first new message opens a new day', () => {
    expect(
      shape([message('$a', '2026-11-04T08:00:00Z'), message('$b', '2026-11-05T08:00:00Z')], '$b')
    ).toEqual(['day:2026-11-04', '$a', 'day:2026-11-05', 'new', '$b'])
  })

  it('is one row with a fixed key', () => {
    const rows = timelineRows(
      [message('$a', `${day}08:00:00Z`), message('$b', `${day}08:10:00Z`)],
      { dayOf: calendarDay, unreadFrom: '$b', me: ME }
    )
    expect(rows.filter((row) => row.kind === 'new')).toEqual([
      { kind: 'new', key: NEW_MESSAGES_KEY },
    ])
  })
})

describe('quarterHourDays', () => {
  it('asks once per quarter hour and answers every moment of it', () => {
    const asked: number[] = []
    const dayOf = quarterHourDays((ts) => {
      asked.push(ts)
      return new Date(ts).toISOString().slice(0, 10)
    })
    const quarter = Date.UTC(2026, 10, 2, 23, 45)
    expect(dayOf(quarter + 1)).toBe('2026-11-02')
    expect(dayOf(quarter + 14 * 60_000)).toBe('2026-11-02')
    expect(dayOf(quarter + 15 * 60_000)).toBe('2026-11-03')
    expect(asked).toEqual([quarter, quarter + 15 * 60_000])
  })

  it('keeps the day a zone a quarter or half an hour off UTC gives at its midnight', () => {
    // Kathmandu, UTC+5:45: local midnight on 3 November is 18:15 UTC on 2 November.
    const kathmandu = (ts: number) =>
      new Date(ts + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10)
    const dayOf = quarterHourDays(kathmandu)
    const midnight = Date.UTC(2026, 10, 2, 18, 15)
    expect(dayOf(midnight - 1)).toBe('2026-11-02')
    expect(dayOf(midnight)).toBe('2026-11-03')
  })
})

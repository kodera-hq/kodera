// The rows a channel's log draws, between and among its messages (gap report G9, reference
// screen p02): a divider where the calendar day changes, and « Nouveaux messages » above the
// first message someone else wrote after the member's read marker. A pure function, so every
// rule is a unit test away; the view supplies the day of each message and where the unread
// messages start, from the marker it noted when the room opened.

import type { MessageView } from './matrix/timeline'

export type TimelineRow =
  | { kind: 'day'; key: string; day: string; ts: number }
  | { kind: 'new'; key: string }
  | { kind: 'message'; key: string; message: MessageView }

export interface RowOptions {
  /** The calendar day a moment falls on, as `YYYY-MM-DD` (`calendarDay` in `i18n/format`). */
  dayOf: (ts: number) => string
  /**
   * The first message after the member's read marker, as it stood when the room opened
   * (`firstShownAfter` in the store). None: no marker is drawn.
   */
  unreadFrom: string | null
  /** The signed-in member: their own messages are never « new » to them. */
  me: string
}

/** The key of the « Nouveaux messages » row; one per log. */
export const NEW_MESSAGES_KEY = 'new-messages'

/**
 * Where « Nouveaux messages » goes: the index of the first message, from the first unread one
 * on, that someone else wrote, the server has, and is not deleted. None when the first unread
 * message is not in the loaded timeline or nothing new follows.
 */
function firstNewIndex(messages: readonly MessageView[], unreadFrom: string | null, me: string) {
  // No message's event id is null, so a room with nothing unread finds nothing.
  const from = messages.findIndex((message) => message.eventId === unreadFrom)
  if (from === -1) return -1
  return messages.findIndex(
    (message, index) =>
      index >= from && message.sender !== me && message.delivery === 'sent' && !message.redacted
  )
}

export function timelineRows(
  messages: readonly MessageView[],
  { dayOf, unreadFrom, me }: RowOptions
): TimelineRow[] {
  const firstNew = firstNewIndex(messages, unreadFrom, me)
  const rows: TimelineRow[] = []
  let previousDay: string | null = null
  messages.forEach((message, index) => {
    const day = dayOf(message.ts)
    // Only forward: a message stamped earlier than the one before it (a device clock behind, a
    // federated server) stays under the current day instead of opening that day a second time.
    if (previousDay === null || day > previousDay) {
      rows.push({ kind: 'day', key: `day-${day}`, day, ts: message.ts })
      previousDay = day
    }
    if (index === firstNew) rows.push({ kind: 'new', key: NEW_MESSAGES_KEY })
    rows.push({ kind: 'message', key: message.key, message })
  })
  return rows
}

/** Every time zone's offset from UTC is a whole number of quarter hours. */
const QUARTER_HOUR_MS = 15 * 60_000
/** Past this many remembered quarters, the memory starts over: a few months of a busy channel. */
const REMEMBERED_QUARTERS = 20_000

/**
 * `dayOf`, remembered per quarter hour. Formatting a calendar day costs a few microseconds, which a
 * ten-thousand-message log would pay at every new message; local midnight always falls on a UTC
 * quarter hour, so every moment of one quarter is on the same day.
 */
export function quarterHourDays(dayOf: (ts: number) => string): (ts: number) => string {
  const known = new Map<number, string>()
  return (ts) => {
    const quarter = Math.floor(ts / QUARTER_HOUR_MS)
    let day = known.get(quarter)
    if (day === undefined) {
      if (known.size >= REMEMBERED_QUARTERS) known.clear()
      day = dayOf(quarter * QUARTER_HOUR_MS)
      known.set(quarter, day)
    }
    return day
  }
}

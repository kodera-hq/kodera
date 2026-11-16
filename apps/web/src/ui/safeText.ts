// Text that came from somewhere else, as a screen may draw it. A display name, a file name or the
// text of a link card is written by whoever sent it: a direction-override character inside one
// makes it read as something else entirely, and a zero-width one hides the difference between two
// of them. Every screen that draws such a string passes it through here first.
//
// A leaf with no imports of its own, so any chunk may use it without reaching into another's.

/** Control, zero-width and direction-override characters: never drawn. */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

/** Text as a screen shows it: one line of plain characters, at most `max` of them. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const plain = value.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim()
  const chars = [...plain]
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('')}\u2026`
}

// Kodera's own emoji (docs/specs/espace-timeline-scale.md): « :kodera_nom: » shortcodes that no
// Unicode emoji writes. The body keeps the code, so another Matrix client shows the code as text;
// Kodera draws each known one as its glyph, from a chunk loaded only when one is first drawn
// (`KoderaEmojiGlyphs.tsx`). Only an exact, known code is drawn: anything else stays text.

/** The codes Kodera draws, in the palette's order. */
export const KODERA_EMOJI = [
  'kodera_mark',
  'kodera_heart',
  'kodera_check',
  'kodera_spark',
  'kodera_coop',
  'kodera_sky',
  'kodera_sun',
  'kodera_wave',
] as const

export type KoderaEmojiName = (typeof KODERA_EMOJI)[number]

const KNOWN: ReadonlySet<string> = new Set(KODERA_EMOJI)

/** A code as it is written in a message. */
export const shortcodeOf = (name: KoderaEmojiName) => `:${name}:`

const CODE = /:(kodera_[a-z0-9_]{1,32}):/gu

export type EmojiSegment = { text: string } | { emoji: KoderaEmojiName }

/** The text cut into plain runs and known Kodera codes, in order; nothing is lost or added. */
export function koderaSegments(text: string): EmojiSegment[] {
  if (!text.includes(':kodera_')) return [{ text }]
  const segments: EmojiSegment[] = []
  let from = 0
  for (const match of text.matchAll(CODE)) {
    const name = match[1]!
    if (!KNOWN.has(name)) continue
    if (match.index > from) segments.push({ text: text.slice(from, match.index) })
    segments.push({ emoji: name as KoderaEmojiName })
    from = match.index + match[0].length
  }
  if (from < text.length) segments.push({ text: text.slice(from) })
  return segments
}

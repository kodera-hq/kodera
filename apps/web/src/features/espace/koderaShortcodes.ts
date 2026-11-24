// Kodera's own emoji (docs/specs/espace-timeline-scale.md) and sanitized workspace custom WebP
// shortcodes: « :kodera_nom: » and « :nom_espace: ». Only exact known codes are drawn, standing
// where the composer's own shortcodes may (`shortcodeGrammar.ts`); anything else stays text.

import { GUARD_AFTER, GUARD_BEFORE } from './shortcodeGrammar'

/** The original Kodera SVG codes, in the palette's order. */
export const KODERA_EMOJI = [
  'kodera_mark',
  'kodera_heart',
  'kodera_check',
  'kodera_spark',
  'kodera_coop',
  'kodera_sky',
  'kodera_sun',
  'kodera_rocket',
  'kodera_fire',
  'kodera_shield',
  'kodera_party',
  'kodera_eyes',
  'kodera_bolt',
  'kodera_wave',
] as const

export type KoderaEmojiName = (typeof KODERA_EMOJI)[number]

const KNOWN: ReadonlySet<string> = new Set(KODERA_EMOJI)

/** A code as it is written in a message. */
export const shortcodeOf = (name: string) => `:${name}:`

export function isKoderaEmojiName(value: string): value is KoderaEmojiName {
  return KNOWN.has(value)
}

const KODERA_CODE = new RegExp(`${GUARD_BEFORE}:(kodera_[a-z0-9_]{1,32}):${GUARD_AFTER}`, 'gu')
const ANY_SHORTCODE = new RegExp(`${GUARD_BEFORE}:([a-z0-9_]{2,32}):${GUARD_AFTER}`, 'gu')

export type EmojiSegment =
  | { text: string }
  | { emoji: KoderaEmojiName }
  | { customEmoji: string }

/**
 * The text cut into plain runs, known Kodera SVG codes, and optional known workspace custom
 * shortcodes, in order; nothing is lost or added.
 */
export function koderaSegments(
  text: string,
  customShortcodes?: ReadonlySet<string>
): EmojiSegment[] {
  const hasCustom = customShortcodes !== undefined && customShortcodes.size > 0
  if (!hasCustom && !text.includes(':kodera_')) return [{ text }]
  if (!text.includes(':')) return [{ text }]

  const pattern = hasCustom ? ANY_SHORTCODE : KODERA_CODE
  const segments: EmojiSegment[] = []
  let from = 0
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!
    if (KNOWN.has(name)) {
      if (match.index > from) segments.push({ text: text.slice(from, match.index) })
      segments.push({ emoji: name as KoderaEmojiName })
      from = match.index + match[0].length
    } else if (hasCustom && customShortcodes.has(name)) {
      if (match.index > from) segments.push({ text: text.slice(from, match.index) })
      segments.push({ customEmoji: name })
      from = match.index + match[0].length
    }
  }
  if (from < text.length) segments.push({ text: text.slice(from) })
  return segments.length === 0 ? [{ text }] : segments
}

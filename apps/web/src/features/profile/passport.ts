// The Kodera Passport: what a member adds to their Matrix profile so others recognise them, kept
// under one key. The member's own copy is their account data (`io.kodera.passport`); a copy is
// also written as a custom field of their global profile (Matrix extended profiles), which is how
// other members read it. Neither is required: a member without one is drawn from their name and
// avatar alone, so a homeserver without extended profiles loses nothing but the banner and bio.

/** The account-data type and the profile field the passport is kept under. */
export const PASSPORT_KEY = 'io.kodera.passport'

/** The banner accents a passport may choose: design-token member tones, never a raw colour. */
export const PASSPORT_ACCENTS = ['cobalt', 't1', 't2', 't3', 't4', 't5', 't6'] as const
export type PassportAccent = (typeof PASSPORT_ACCENTS)[number]

/** The longest bio, in characters. */
export const MAX_BIO = 160
/** The most custom tags, and the longest one. */
export const MAX_TAGS = 4
export const MAX_TAG = 24

export interface Passport {
  accent: PassportAccent
  bio: string
  tags: readonly string[]
  /** The first-run passport card was saved or dismissed: it is not offered again. */
  onboarded: boolean
}

export const EMPTY_PASSPORT: Passport = Object.freeze({
  accent: 'cobalt',
  bio: '',
  tags: Object.freeze([]) as readonly string[],
  onboarded: false,
})

function clean(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  // Control characters and bidirectional overrides never reach a screen.
  return text
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .trim()
    .slice(0, max)
}

/** A passport read from anywhere, checked: what is not as written is dropped, never trusted. */
export function passportOf(content: unknown): Passport {
  if (content === null || typeof content !== 'object' || Array.isArray(content))
    return EMPTY_PASSPORT
  const value = content as Record<string, unknown>
  const accent = PASSPORT_ACCENTS.find((candidate) => candidate === value.accent) ?? 'cobalt'
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags.map((tag) => clean(tag, MAX_TAG)).filter(Boolean))].slice(0, MAX_TAGS)
    : []
  return { accent, bio: clean(value.bio, MAX_BIO), tags, onboarded: value.onboarded === true }
}

/**
 * Whether a display name is no name a person chose: empty, the four hexadecimal characters a raw
 * subject starts with (`32dc`), a QA or e-mail localpart (`qa+lane3`, `jane.doe@acme.fr`), or the
 * id's own localpart. The first-run passport is offered to such a member.
 */
export function isPlaceholderName(name: string | undefined, userId: string): boolean {
  const value = (name ?? '').trim()
  if (value === '') return true
  if (/^[0-9a-f]{4,}$/iu.test(value)) return true
  if (/^qa\+/iu.test(value) || /^[^\s@]+@[^\s@]+$/u.test(value)) return true
  const localpart = userId.startsWith('@') ? userId.slice(1, userId.indexOf(':')) : ''
  return localpart !== '' && value.toLowerCase() === localpart.toLowerCase()
}

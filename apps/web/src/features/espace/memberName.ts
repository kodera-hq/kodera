import { cleanText } from '../../ui/safeText'

/**
 * A localpart that names nobody: Core's own person id, which Synapse takes as the account's
 * localpart. Title-casing one gives « Ce239589 A4bd 41db 9cfb D06e66a77ff3 », a string no member
 * recognises as a person, so it is never drawn as a name.
 */
const OPAQUE_LOCALPART = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu

export function isOpaqueLocalpart(localpart: string): boolean {
  return OPAQUE_LOCALPART.test(localpart)
}

/** The characters a screen draws as `@` or `:` without being them. */
const CONFUSABLE_AT = /[\uFF20\uFE6B]/gu
const CONFUSABLE_COLON = /[\u2236\uA789\uFE55\uFF1A\u05C3\u02D0\u0589\u1361]/gu

/** A name folded to the characters it reads as, so a look-alike is judged as what it looks like. */
function foldConfusables(value: string): string {
  return value.normalize('NFKC').replace(CONFUSABLE_AT, '@').replace(CONFUSABLE_COLON, ':')
}

/** `@something:somewhere`, anywhere in the string, with or without spaces around the colon. */
const MATRIX_ID_SHAPED = /@[^\s:]+\s*:\s*\S/u

/**
 * Whether a display name says anything the id does not. Synapse hands a new account its own
 * localpart as a display name, so « ce239589-a4bd-… » is an unset profile wearing a value. Judge
 * the text a screen will actually draw: `safeDisplayName` cleans before calling this, and so
 * should any other caller.
 */
export function isNamedProfile(name: string | undefined, userId: string): boolean {
  if (name === undefined) return false
  const trimmed = name.trim()
  if (trimmed === '') return false
  const localpart = userId.startsWith('@') ? (userId.slice(1).split(':')[0] ?? '') : ''
  // A name carrying something shaped like a Matrix id is not a name: drawn beside real ones it
  // reads as somebody else's account, whoever set it. The whole string is judged, not its first
  // character, and the characters that merely look like `@` and `:` are folded to them first —
  // otherwise `＠someone։host` passes the test and still reads as an id on the screen.
  if (MATRIX_ID_SHAPED.test(foldConfusables(trimmed))) return false
  return trimmed !== localpart && trimmed !== userId && !isOpaqueLocalpart(trimmed)
}

/**
 * The name drawn for a member the room holds no display name for: its id's localpart, and — where
 * that localpart names nobody — its first four characters, which tell two members apart. `unnamed`
 * is the word the caller's language has for a member with no name; without one, the characters
 * stand alone, so a caller with no translation at hand still draws something short.
 */
export function displayNameOf(userId: string, unnamed?: string): string {
  const cleanId = cleanText(userId, 255)
  if (!cleanId.startsWith('@')) return cleanId
  const localpart = cleanId.slice(1).split(':')[0] ?? cleanId
  if (isOpaqueLocalpart(localpart)) {
    const short = localpart.replace(/-/gu, '').slice(0, 4)
    return unnamed === undefined ? short : `${unnamed} · ${short}`
  }
  return localpart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * The name to draw for a member, from whatever a room holds for them. A display name is set by
 * the member themselves, so it is untrusted text: its control, zero-width and direction-override
 * characters are stripped before it is drawn (`cleanText`, the same rule the link cards use), and
 * one that names nobody gives way to the few characters of the id that tell two members apart.
 */
export function safeDisplayName(
  name: string | undefined,
  userId: string,
  unnamed?: string
): string {
  // Cleaned first, judged second. A name judged before its direction-override characters are
  // stripped is judged on something other than what the screen will draw: « \u202E@someone:host »
  // does not look like an id until the override is gone, and then it is one.
  const clean = cleanText(name, 80)
  return isNamedProfile(clean, userId) ? clean : displayNameOf(userId, unnamed)
}

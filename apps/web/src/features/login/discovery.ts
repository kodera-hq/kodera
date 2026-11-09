// Realm discovery (docs/specs/00-shell-and-login.md §4.1, §8): the pure,
// framework-free part — normalising and validating what a person typed,
// before it ever reaches `POST /auth/discover` (`useDiscoverRealm` in
// `discoverRealm.ts`). Kept separate from the screen component so the rules
// in §8 ("Discovery is deliberately forgiving") are unit-tested directly
// rather than only through a rendered form.

import { isDiscoveryEmail } from '../../api/discoveryEmail'
import { isOrganisationSlug } from '../../api/organisationSlug'

/** Strips leading/trailing space and lower-cases — the two things §8 asks
 * for on every discovery input, email or slug alike. */
function trimLower(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeEmail(raw: string): string {
  return trimLower(raw)
}

/**
 * §8: "a pasted `https://acme-sa.kodera.io` is reduced to `acme-sa` rather than
 * rejected." The slug charset (`a-z`, `0-9`, `-`) never contains a dot, so
 * any dot left after stripping a leading scheme and path is the sign of a
 * pasted host, not a decision this function has to guess at.
 */
export function normalizeSlug(raw: string): string {
  let value = trimLower(raw)
  value = value.replace(/^https?:\/\//, '')
  value = (value.split('/')[0] ?? value).trim()
  const dotIndex = value.indexOf('.')
  if (dotIndex !== -1) value = value.slice(0, dotIndex)
  return value
}

/**
 * §8: "Contains `@` and a dot-bearing domain; no format lecture beyond
 * that." Deliberately loose — this is not RFC 5322 validation, it is the
 * minimum a person can act on.
 */
export function isEmailFormatValid(email: string): boolean {
  const at = email.indexOf('@')
  if (at <= 0 || at === email.length - 1) return false
  const domain = email.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

/**
 * Whether `POST /auth/discover` accepts the address: the contract's "approved
 * ASCII email" (`src/api/discoveryEmail.ts`). An address that passes
 * `isEmailFormatValid` but not this one — an accented letter, a space, two dots
 * in a row — is refused with `422`, which the screen could only answer with its
 * generic message; checked here, it gets its own before anything is sent.
 */
export function isEmailAcceptedForDiscovery(email: string): boolean {
  return isDiscoveryEmail(email)
}

/** The persisted organisation slug, 5 to 20 characters, as the pinned contract spells it
 * (`src/api/organisationSlug.ts`); tenant order names have a separate rule. */
export function isSlugFormatValid(slug: string): boolean {
  return isOrganisationSlug(slug)
}

/** The domain part of an email, for the "no organisation uses {domain}"
 * message (`console.login.realm.error-domain-unknown`). */
export function emailDomain(email: string): string {
  return email.slice(email.indexOf('@') + 1)
}

/** What is wrong with an address typed on the e-mail step, or `undefined` when discovery may be
 * asked. Judged on `normalizeEmail(raw)` — the address `onSubmitEmail` sends — never on the raw
 * input: lower-casing can turn a character outside ASCII into an ASCII one (U+212A KELVIN SIGN
 * becomes `k`), so checking before normalising would refuse an address the contract accepts and
 * could pass one it refuses. An incomplete address is told what is missing; a complete one the
 * contract would still refuse is told why — never both (§8). */
export type EmailRefusal = 'required' | 'incomplete' | 'refused'

export function emailRefusal(raw: string): EmailRefusal | undefined {
  const email = normalizeEmail(raw)
  if (email === '') return 'required'
  if (!isEmailFormatValid(email)) return 'incomplete'
  if (!isEmailAcceptedForDiscovery(email)) return 'refused'
  return undefined
}

/** The longest wait discovery's `503` imposes, whatever `retry_after_s` says (§9): about a
 * minute, after which the person may ask again and Core answers afresh. */
export const DISCOVERY_WAIT_CAP_S = 60

/** The wait after a `503` when Core gives none, and its minimum: the contract's five-second
 * backoff, `Retry-After: 5`. */
export const UNAVAILABLE_WAIT_S = 5

/** The wait after a `429` that does not say how long. */
export const DEFAULT_RATE_LIMIT_WAIT_S = 60

/** The longest `429` wait the countdown can hold: its deadline is `Date.now() + seconds * 1000`,
 * exact in milliseconds only up to `Number.MAX_SAFE_INTEGER` (about 285,000 years). A longer one
 * — `1e306` makes the deadline `Infinity` — is no wait a countdown can say. */
export const MAX_COUNTABLE_WAIT_S = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

/** A `retry_after_s` worth reading: a number, not `NaN`. `Infinity` and other huge values are
 * kept — they say "long" — and each caller decides what long means. */
function given(retryAfterS: number | undefined): number | undefined {
  return retryAfterS === undefined || Number.isNaN(retryAfterS) ? undefined : retryAfterS
}

/**
 * The seconds a `429` holds the button (§9); `0` when there is nothing to count down. The
 * contract's `retry_after_s` is `integer | null`, minimum 0, but it arrives over the network:
 * - none given, or `NaN`: a minute;
 * - `Infinity` (`JSON.parse('1e999')`), or more than `MAX_COUNTABLE_WAIT_S` (`1e306`): no wait a
 *   countdown can say, so a minute, as if none were given;
 * - a part of a second: rounded up, so the sentence and the wait agree;
 * - zero or less (`-Infinity` included): nothing to wait for;
 * - any other value: honoured, the spec's minutes and hours presentation included. A hostile
 *   but countable wait — a year — holds the button until it elapses, by design (§9).
 */
export function rateLimitWaitSeconds(retryAfterS: number | undefined): number {
  const value = given(retryAfterS)
  if (value === undefined || value > MAX_COUNTABLE_WAIT_S) return DEFAULT_RATE_LIMIT_WAIT_S
  return Math.max(0, Math.ceil(value))
}

/** The seconds a `503` holds the button (§9): never less than the contract's five, never more
 * than `DISCOVERY_WAIT_CAP_S`, whatever arrived — `Infinity`, `1e306` and a year included; `NaN`
 * waits the five seconds, as if none were given. */
export function unavailableWaitSeconds(retryAfterS: number | undefined): number {
  const value = given(retryAfterS) ?? UNAVAILABLE_WAIT_S
  return Math.min(DISCOVERY_WAIT_CAP_S, Math.max(UNAVAILABLE_WAIT_S, Math.ceil(value)))
}

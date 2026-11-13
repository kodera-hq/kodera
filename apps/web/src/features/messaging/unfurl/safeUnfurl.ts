// A link preview, checked before it is drawn (docs/specs/messaging-media-and-notifications.md).
// Core fetches the page and returns plain text (`UnfurlResult`); the console still trusts none of
// it. Only an http or https address is kept; `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`
// and anything else make the whole card refused, since a card is a link the member will click.
// Text loses its control and direction-override characters and is cut to the contract's lengths.
//
// No image is drawn: the console's policy allows images from its own origin only (`img-src
// 'self'`), and a remote image would tell its host who read the message and when.

import type { components } from '../../../api/schema'

export type UnfurlResult = components['schemas']['UnfurlResult']

export interface SafeUnfurl {
  /** Where the card leads: the canonical address when it is on the same site, else the one sent. */
  href: string
  /** The host shown under the title, so the member sees where the link goes. */
  host: string
  title: string
  description: string
  siteName: string
}

const SAFE_PROTOCOLS = new Set(['https:', 'http:'])

/** An address a card may lead to, or null. */
export function safeHref(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  // Browsers drop these before parsing a scheme: « java\tscript: » must not pass as text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/u.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return null
  if (url.username !== '' || url.password !== '') return null
  return url
}

/** Control, zero-width and direction-override characters: never shown in a card. */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

/** Text as a card shows it: one line of plain characters, at most `max` of them. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const plain = value.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim()
  const chars = [...plain]
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * The resource an address names, as Core's fetcher sees it: no fragment (a browser never sends
 * one, and Core's canonical form drops it) and the path and query with their unreserved
 * percent-escapes decoded, since Core escapes `|`, `^`, `[` and `]` where a browser keeps them.
 * `decodeURI` leaves the reserved escapes (`%2F`, `%3F`, `%23`, `%26`, …) as they are.
 */
function resourceOf(url: URL): string {
  const rest = url.pathname + url.search
  let decoded = rest
  try {
    decoded = decodeURI(rest)
  } catch {
    // A malformed escape is compared as written.
  }
  return url.protocol + '//' + url.host + decoded
}

/**
 * The card for a link the member sent, or null to draw none. `sent` is the address in the message:
 * a result for another address is refused, and a canonical address on another site is not
 * followed, so a preview never leads somewhere the message did not.
 */
export function safeUnfurl(result: unknown, sent: string): SafeUnfurl | null {
  if (result === null || typeof result !== 'object') return null
  const card = result as Partial<Record<keyof UnfurlResult, unknown>>
  const asked = safeHref(sent)
  const url = safeHref(card.url)
  if (asked === null || url === null || resourceOf(url) !== resourceOf(asked)) return null
  const canonical = safeHref(card.canonicalUrl)
  // A canonical address in any other scheme refuses the card: the server should never return one.
  if (card.canonicalUrl !== undefined && canonical === null) return null
  // Without a same-site canonical address the card leads where the message does, fragment included.
  const target = canonical !== null && canonical.host === url.host ? canonical : asked
  const title = cleanText(card.title, 120)
  const description = cleanText(card.description, 300)
  const siteName = cleanText(card.siteName, 80)
  if (title === '' && description === '') return null
  return { href: target.href, host: target.host, title, description, siteName }
}

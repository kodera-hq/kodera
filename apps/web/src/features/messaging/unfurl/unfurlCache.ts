// Link previews, asked of Core once per address and kept for the page's life
// (docs/specs/messaging-media-and-notifications.md). Core fetches the page; the console only ever
// receives text, checked by `safeUnfurl` before a card is drawn. A failed or refused preview is
// remembered as none, so a broken link is not asked for again on every redraw.

import { mutate } from '../../../api/mutations'
import { registerLocalSessionCleanup } from '../../../auth/localSession'
import { safeHref, safeUnfurl, type SafeUnfurl } from './safeUnfurl'

/** The first web address in a message's text, outside inline and fenced code; null when none. */
export function firstLink(body: string): string | null {
  const prose = body.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\n]*`/gu, ' ')
  for (const match of prose.matchAll(/https?:\/\/[^\s<>()"'`]+/giu)) {
    const candidate = match[0].replace(/[.,;:!?…»]+$/u, '')
    if (safeHref(candidate) !== null) return candidate
  }
  return null
}

type Entry = { state: 'loading' } | { state: 'done'; card: SafeUnfurl | null }

/** The most addresses kept at once; asking for one more evicts the oldest. */
export const MAX_ENTRIES = 300

export class UnfurlCache {
  readonly #entries = new Map<string, Entry>()
  readonly #listeners = new Set<() => void>()
  readonly #fetch: (organisationId: string, url: string) => Promise<unknown>
  #resetGeneration = 0

  constructor(fetch: (organisationId: string, url: string) => Promise<unknown> = askCore) {
    this.#fetch = fetch
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  card(organisationId: string, url: string): SafeUnfurl | null | undefined {
    const entry = this.#entries.get(`${organisationId} ${url}`)
    return entry?.state === 'done' ? entry.card : undefined
  }

  reset(): void {
    ++this.#resetGeneration
    if (this.#entries.size === 0) return
    this.#entries.clear()
    for (const listener of this.#listeners) listener()
  }

  /** Asks Core once for this address; later calls for it do nothing. */
  request(organisationId: string, url: string): void {
    const key = `${organisationId} ${url}`
    if (this.#entries.has(key)) return
    if (this.#entries.size >= MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value
      if (oldest !== undefined) this.#entries.delete(oldest)
    }
    const pending: Entry = { state: 'loading' }
    const generation = this.#resetGeneration
    this.#entries.set(key, pending)
    this.#fetch(organisationId, url).then(
      (result) => this.#settle(generation, key, pending, safeUnfurl(result, url)),
      () => this.#settle(generation, key, pending, null)
    )
  }

  #settle(generation: number, key: string, expected: Entry, card: SafeUnfurl | null) {
    // An entry evicted or reset while its fetch was in flight stays out: its late settlement
    // must never populate a later session's entry or grow above the cap.
    if (generation !== this.#resetGeneration || this.#entries.get(key) !== expected) return
    this.#entries.set(key, { state: 'done', card })
    for (const listener of this.#listeners) listener()
  }
}

function askCore(organisationId: string, url: string): Promise<unknown> {
  return mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/unfurl' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: { url },
    }
  )
}

export const unfurlCache = new UnfurlCache()
registerLocalSessionCleanup(() => {
  unfurlCache.reset()
})

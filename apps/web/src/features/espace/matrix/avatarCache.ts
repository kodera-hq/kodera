// Members' avatars, as a screen draws them. The console's policy names no remote image source
// (`img-src 'self' blob:`), and a homeserver's authenticated media endpoint wants the member's
// token, so an `mxc://` address is never an `<img src>`: the store fetches its bytes with the
// token (`EspaceStore.fetchAvatar`), and this cache turns them into a `blob:` address this page
// holds. Bounded: past `capacity` addresses the least recently drawn one is dropped and its object
// URL revoked, so a long session in a large workspace does not keep every face it ever saw.
//
// Read with `useSyncExternalStore`: `get` answers at once from what is held and asks for what is
// not; the listeners hear when an answer arrives.

/** Fetches an avatar's bytes; null where there is none to draw. */
export type AvatarFetch = (mxcUrl: string) => Promise<Blob | null>

/** How many avatars a session holds at once. */
export const AVATAR_CACHE_CAPACITY = 256

/** How long an address that gave nothing is not asked again. */
const MISS_FOR_MS = 5 * 60_000

const MXC = /^mxc:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9_-]+$/u

/** Whether the address is one the cache resolves: `mxc://server/media-id`, nothing more. */
export function isMxcUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && MXC.test(value)
}

export interface ObjectUrls {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

const browserUrls: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

export class AvatarCache {
  readonly #fetch: AvatarFetch
  readonly #capacity: number
  readonly #urls: ObjectUrls
  readonly #now: () => number
  /** Insertion order is recency: a hit moves its entry to the end. */
  readonly #held = new Map<string, string>()
  readonly #asking = new Map<string, Promise<string | null>>()
  readonly #missed = new Map<string, number>()
  readonly #listeners = new Set<() => void>()
  #version = 0
  #closed = false

  constructor(
    fetch: AvatarFetch,
    {
      capacity = AVATAR_CACHE_CAPACITY,
      urls = browserUrls,
      now = Date.now,
    }: { capacity?: number; urls?: ObjectUrls; now?: () => number } = {}
  ) {
    this.#fetch = fetch
    this.#capacity = Math.max(1, capacity)
    this.#urls = urls
    this.#now = now
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Changes whenever an avatar arrives or leaves: the token `useSyncExternalStore` compares. */
  getVersion = (): number => this.#version

  /** How many avatars are held now. */
  get size(): number {
    return this.#held.size
  }

  /**
   * The avatar's `blob:` address if it is held, and a request for it otherwise. Never throws, and
   * never asks twice at once for one address, nor again soon for one that gave nothing.
   */
  get = (mxcUrl: string | undefined): string | undefined => {
    if (this.#closed || !isMxcUrl(mxcUrl)) return undefined
    const held = this.#held.get(mxcUrl)
    if (held !== undefined) {
      this.#held.delete(mxcUrl)
      this.#held.set(mxcUrl, held)
      return held
    }
    void this.load(mxcUrl)
    return undefined
  }

  /** Resolves to the avatar's `blob:` address, or null where there is none. */
  load(mxcUrl: string): Promise<string | null> {
    if (this.#closed || !isMxcUrl(mxcUrl)) return Promise.resolve(null)
    const held = this.#held.get(mxcUrl)
    if (held !== undefined) return Promise.resolve(held)
    const asking = this.#asking.get(mxcUrl)
    if (asking !== undefined) return asking
    const missed = this.#missed.get(mxcUrl)
    if (missed !== undefined && this.#now() - missed < MISS_FOR_MS) return Promise.resolve(null)
    const request = this.#fetch(mxcUrl)
      .catch(() => null)
      .then((blob) => {
        if (this.#closed) return null
        if (blob === null) {
          this.#missed.set(mxcUrl, this.#now())
          return null
        }
        this.#missed.delete(mxcUrl)
        const url = this.#urls.create(blob)
        this.#held.set(mxcUrl, url)
        this.#evict()
        this.#changed()
        return url
      })
      .finally(() => this.#asking.delete(mxcUrl))
    this.#asking.set(mxcUrl, request)
    return request
  }

  /** The avatar failed to draw (a broken image): dropped, and not asked again for a while. */
  forget(mxcUrl: string): void {
    const held = this.#held.get(mxcUrl)
    if (held === undefined) return
    this.#held.delete(mxcUrl)
    this.#urls.revoke(held)
    this.#missed.set(mxcUrl, this.#now())
    this.#changed()
  }

  /** Revokes every address it made; nothing more is fetched. The session is over. */
  close(): void {
    this.#closed = true
    for (const url of this.#held.values()) this.#urls.revoke(url)
    this.#held.clear()
    this.#asking.clear()
    this.#missed.clear()
    this.#changed()
  }

  #evict(): void {
    while (this.#held.size > this.#capacity) {
      const [oldest, url] = this.#held.entries().next().value as [string, string]
      this.#held.delete(oldest)
      this.#urls.revoke(url)
    }
  }

  #changed(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

// What a channel last showed, kept on this device so it opens before the first sync answers
// (docs/specs/espace-timeline-scale.md). Only the message views are kept: never a token, never a
// raw event, never a message this device has not had acknowledged. Each room keeps its newest
// `CACHED_MESSAGES`, under the signed-in member's id, and the whole cache is wiped when the
// Matrix session ends (a sign-out, or another sign-in in this tab), so the next member of a
// shared browser finds nothing.
//
// The backend is pluggable: IndexedDB in the browser, a map in the unit tests. What is read back
// is checked field by field; a record of another shape, version or member is ignored.

import { getMatrixSession, subscribeMatrixSession } from '@/auth/matrix'
import type { MessageView, Reaction } from './timeline'

/** The newest messages each room keeps: enough for a first screen and a short scroll back. */
export const CACHED_MESSAGES = 200

/** How long a room's changes wait before they are written: one write per burst of events. */
export const CACHE_WRITE_DELAY_MS = 750

const RECORD_VERSION = 1

export interface CachedRoom {
  v: number
  userId: string
  roomId: string
  savedAt: number
  messages: MessageView[]
}

/** Where the records live. Keys are `${userId}\n${roomId}`. */
export interface CacheBackend {
  /** Every record whose key starts with the prefix. */
  entries(prefix: string): Promise<unknown[]>
  put(key: string, value: CachedRoom): Promise<void>
  delete(key: string): Promise<void>
  /** Every record, every member's. */
  clear(): Promise<void>
}

const keyOf = (userId: string, roomId: string) => `${userId}\n${roomId}`

function isReaction(value: unknown): value is Reaction {
  if (value === null || typeof value !== 'object') return false
  const reaction = value as Record<string, unknown>
  return (
    typeof reaction.key === 'string' &&
    typeof reaction.count === 'number' &&
    typeof reaction.mine === 'boolean'
  )
}

const optional = (value: unknown, type: 'string' | 'boolean') =>
  value === undefined || typeof value === type

function isNamed(value: unknown, fields: readonly string[]): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  return fields.every((field) => typeof (value as Record<string, unknown>)[field] === 'string')
}

/** A sent message view, as this module writes one; anything else is not read back. */
export function isCachedMessage(value: unknown): value is MessageView {
  if (value === null || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m.key === 'string' &&
    typeof m.eventId === 'string' &&
    typeof m.sender === 'string' &&
    typeof m.body === 'string' &&
    typeof m.ts === 'number' &&
    Number.isFinite(m.ts) &&
    typeof m.edited === 'boolean' &&
    typeof m.redacted === 'boolean' &&
    m.delivery === 'sent' &&
    (m.replyTo === null || typeof m.replyTo === 'string') &&
    Array.isArray(m.reactions) &&
    m.reactions.every(isReaction) &&
    optional(m.senderName, 'string') &&
    (m.mentionsMe === undefined || m.mentionsMe === true) &&
    isNamed(m.document, ['id', 'title']) &&
    isNamed(m.attachment, ['name'])
  )
}

function readRecord(value: unknown, userId: string): CachedRoom | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.v !== RECORD_VERSION || record.userId !== userId) return null
  if (typeof record.roomId !== 'string' || typeof record.savedAt !== 'number') return null
  if (!Array.isArray(record.messages) || !record.messages.every(isCachedMessage)) return null
  return record as unknown as CachedRoom
}

/** What a room keeps: its newest sent messages, copied so a later change in place is not kept. */
function keptOf(messages: readonly MessageView[], limit: number): MessageView[] {
  const sent = messages.filter((message) => message.delivery === 'sent')
  return sent.slice(Math.max(0, sent.length - limit)).map((message) => ({
    ...message,
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
  }))
}

export interface TimelineCacheOptions {
  limit?: number
  delayMs?: number
  now?: () => number
}

/** One member's cache, for one store's lifetime. Closed or wiped, it writes nothing more. */
export class TimelineCache {
  readonly #backend: CacheBackend
  readonly #userId: string
  readonly #limit: number
  readonly #delayMs: number
  readonly #now: () => number
  readonly #pending = new Map<string, readonly MessageView[]>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #writing: Promise<void> = Promise.resolve()
  #closed = false

  constructor(backend: CacheBackend, userId: string, options: TimelineCacheOptions = {}) {
    this.#backend = backend
    this.#userId = userId
    this.#limit = options.limit ?? CACHED_MESSAGES
    this.#delayMs = options.delayMs ?? CACHE_WRITE_DELAY_MS
    this.#now = options.now ?? Date.now
    open.add(this)
  }

  /** Every room this member's cache holds; a backend that fails gives nothing. */
  async loadAll(): Promise<Map<string, readonly MessageView[]>> {
    const rooms = new Map<string, readonly MessageView[]>()
    let values: unknown[]
    try {
      values = await this.#backend.entries(keyOf(this.#userId, ''))
    } catch {
      return rooms
    }
    if (this.#closed) return rooms
    for (const value of values) {
      const record = readRecord(value, this.#userId)
      if (record !== null && record.messages.length > 0) rooms.set(record.roomId, record.messages)
    }
    return rooms
  }

  /** Keeps a room's messages, written after a short wait; the last call in the wait wins. */
  save(roomId: string, messages: readonly MessageView[]): void {
    if (this.#closed) return
    this.#pending.set(roomId, messages)
    this.#timer ??= setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#delayMs)
  }

  /** Forgets a room the member is no longer in. */
  forget(roomId: string): void {
    if (this.#closed) return
    this.#pending.delete(roomId)
    this.#chain(() => this.#backend.delete(keyOf(this.#userId, roomId)))
  }

  /** Writes what is waiting now. */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const batch = [...this.#pending]
    this.#pending.clear()
    for (const [roomId, messages] of batch) {
      const record: CachedRoom = {
        v: RECORD_VERSION,
        userId: this.#userId,
        roomId,
        savedAt: this.#now(),
        messages: keptOf(messages, this.#limit),
      }
      this.#chain(() =>
        record.messages.length === 0
          ? this.#backend.delete(keyOf(this.#userId, roomId))
          : this.#backend.put(keyOf(this.#userId, roomId), record)
      )
    }
    return this.#writing
  }

  /** The store stops: what is waiting is written, and nothing after. */
  close(): Promise<void> {
    if (this.#closed) return this.#writing
    const done = this.flush()
    this.#closed = true
    open.delete(this)
    return done
  }

  /** The session ended: nothing waiting is written, and every record goes. */
  async wipe(): Promise<void> {
    await this.halt()
    await wipeTimelineCaches(this.#backend)
  }

  /** Drops what is waiting and writes nothing more; resolves once the writes queued have landed. */
  halt(): Promise<void> {
    this.#closed = true
    open.delete(this)
    this.#pending.clear()
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    return this.#writing
  }

  #chain(write: () => Promise<void>): void {
    // A refused write (storage full, private window) loses a cache, never a message.
    this.#writing = this.#writing.then(write).catch(() => undefined)
  }
}

/** The caches of the stores alive now: a wipe stops them all first. */
const open = new Set<TimelineCache>()

/** Stops every open cache, waits for its queued writes, then clears every record. */
export async function wipeTimelineCaches(backend: CacheBackend): Promise<void> {
  await Promise.all([...open].map((cache) => cache.halt()))
  try {
    await backend.clear()
  } catch {
    // Nothing to clear (storage refused): nothing was kept either.
  }
}

/** A map, for the unit tests and for a browser with no IndexedDB. */
export function memoryBackend(): CacheBackend & { readonly records: Map<string, CachedRoom> } {
  const records = new Map<string, CachedRoom>()
  return {
    records,
    entries: async (prefix) =>
      [...records].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
    put: async (key, value) => {
      records.set(key, structuredClone(value))
    },
    delete: async (key) => {
      records.delete(key)
    },
    clear: async () => {
      records.clear()
    },
  }
}

export const CACHE_DATABASE = 'kodera-espace-timelines'
const OBJECT_STORE = 'rooms'

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** The browser's IndexedDB, one object store keyed by member and room. */
export function indexedDbBackend(factory: IDBFactory = indexedDB): CacheBackend {
  let database: Promise<IDBDatabase> | null = null
  const db = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(CACHE_DATABASE, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
          request.result.createObjectStore(OBJECT_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB refused'))
      request.onblocked = () => reject(new Error('IndexedDB blocked'))
    }).catch((error: unknown) => {
      database = null
      throw error
    })
    return database
  }
  const run = async <T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const transaction = (await db()).transaction(OBJECT_STORE, mode)
    const result = done(act(transaction.objectStore(OBJECT_STORE)))
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'))
    })
    return result
  }
  return {
    entries: (prefix) =>
      run('readonly', (store) =>
        store.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`, false, false))
      ),
    put: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key))
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key))
    },
    clear: async () => {
      await run('readwrite', (store) => store.clear())
    },
  }
}

let browserBackend: CacheBackend | null = null
let wipeOnSignOut = false

/**
 * The signed-in member's cache in this browser, or none where IndexedDB is missing. The first
 * one opened also wipes every record when the Matrix session ends.
 */
export function openTimelineCache(userId: string): TimelineCache | undefined {
  if (typeof indexedDB === 'undefined') return undefined
  browserBackend ??= indexedDbBackend()
  const backend = browserBackend
  if (!wipeOnSignOut) {
    wipeOnSignOut = true
    subscribeMatrixSession(() => {
      if (getMatrixSession() === undefined) void wipeTimelineCaches(backend)
    })
  }
  return new TimelineCache(backend, userId)
}

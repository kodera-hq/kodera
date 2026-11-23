// Standards-faithful in-memory `IDBFactory` for Vitest (`jsdom` has no built-in IndexedDB).
// Preserves non-extractable WebCrypto `CryptoKey` references across structured-clone simulation,
// enforces `{ durability: 'strict' }`, supports transaction rollback on `abort()`, and exposes
// raw store inspection so tests can prove zero-plaintext storage, AAD binding, and tombstones.

interface StoredStoreData {
  readonly keyPath: string
  readonly indexes: Map<string, string>
  rows: Map<string, unknown>
}

interface StoredDb {
  version: number
  readonly stores: Map<string, StoredStoreData>
  readonly handles: Set<MockIdbDatabase>
}

function isAnyArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  )
}

function clonePreservingCryptoKey<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (
    (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) ||
    Object.prototype.toString.call(value) === '[object CryptoKey]'
  ) {
    return value
  }
  if (isAnyArrayBuffer(value)) {
    const src = new Uint8Array(value)
    const dst = new Uint8Array(src.byteLength)
    dst.set(src)
    return dst.buffer as unknown as T
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const dst = new Uint8Array(view.byteLength)
    dst.set(view)
    return dst.buffer as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePreservingCryptoKey(item)) as unknown as T
  }
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) {
      copy[k] = clonePreservingCryptoKey(v)
    }
  }
  return copy as T
}

function makeRequest<T>(executor: () => T, onSettled?: (ok: boolean, error?: unknown) => void): IDBRequest<T> {
  const req: {
    result: T
    error: DOMException | null
    onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null
    onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null
  } = {
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
  }
  queueMicrotask(() => {
    try {
      req.result = executor()
      req.onsuccess?.call(req as unknown as IDBRequest<T>, new Event('success'))
      onSettled?.(true)
    } catch (err) {
      req.error =
        err instanceof DOMException
          ? err
          : new DOMException(err instanceof Error ? err.message : String(err), 'ConstraintError')
      req.onerror?.call(req as unknown as IDBRequest<T>, new Event('error'))
      onSettled?.(false, req.error)
    }
  })
  return req as unknown as IDBRequest<T>
}

class MockIdbIndex {
  readonly #store: StoredStoreData
  readonly #indexField: string
  readonly #track: <T>(fn: () => T) => IDBRequest<T>

  constructor(
    store: StoredStoreData,
    indexField: string,
    track: <T>(fn: () => T) => IDBRequest<T>
  ) {
    this.#store = store
    this.#indexField = indexField
    this.#track = track
  }

  getAll(query?: IDBValidKey | IDBKeyRange | null): IDBRequest<unknown[]> {
    return this.#track(() => {
      const out: unknown[] = []
      for (const row of this.#store.rows.values()) {
        const fieldVal = (row as Record<string, unknown>)[this.#indexField]
        if (query === undefined || query === null || fieldVal === query) {
          out.push(clonePreservingCryptoKey(row))
        }
      }
      return out
    })
  }

  count(query?: IDBValidKey | IDBKeyRange): IDBRequest<number> {
    return this.#track(() => {
      let total = 0
      for (const row of this.#store.rows.values()) {
        const fieldVal = (row as Record<string, unknown>)[this.#indexField]
        if (query === undefined || fieldVal === query) total += 1
      }
      return total
    })
  }
}

class MockIdbObjectStore {
  readonly name: string
  readonly #store: StoredStoreData
  readonly #mode: IDBTransactionMode
  readonly #track: <T>(fn: () => T) => IDBRequest<T>

  constructor(
    name: string,
    store: StoredStoreData,
    mode: IDBTransactionMode,
    track: <T>(fn: () => T) => IDBRequest<T>
  ) {
    this.name = name
    this.#store = store
    this.#mode = mode
    this.#track = track
  }

  createIndex(name: string, keyPath: string): IDBIndex {
    this.#store.indexes.set(name, keyPath)
    return new MockIdbIndex(this.#store, keyPath, this.#track) as unknown as IDBIndex
  }

  index(name: string): IDBIndex {
    const field = this.#store.indexes.get(name)
    if (field === undefined) throw new DOMException(`Index ${name} not found`, 'NotFoundError')
    return new MockIdbIndex(this.#store, field, this.#track) as unknown as IDBIndex
  }

  #ensureWritable(): void {
    if (this.#mode === 'readonly') {
      throw new DOMException('Read-only transaction', 'ReadOnlyError')
    }
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    return this.#track(() => {
      const found = this.#store.rows.get(String(key))
      return found === undefined ? undefined : clonePreservingCryptoKey(found)
    })
  }

  getAll(): IDBRequest<unknown[]> {
    return this.#track(() => [...this.#store.rows.values()].map((r) => clonePreservingCryptoKey(r)))
  }

  count(): IDBRequest<number> {
    return this.#track(() => this.#store.rows.size)
  }

  add(value: unknown): IDBRequest<IDBValidKey> {
    return this.#track<IDBValidKey>(() => {
      this.#ensureWritable()
      const key = String((value as Record<string, unknown>)[this.#store.keyPath])
      if (this.#store.rows.has(key)) {
        throw new DOMException('Key already exists', 'ConstraintError')
      }
      this.#store.rows.set(key, clonePreservingCryptoKey(value))
      return key
    })
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    return this.#track<IDBValidKey>(() => {
      this.#ensureWritable()
      const key = String((value as Record<string, unknown>)[this.#store.keyPath])
      this.#store.rows.set(key, clonePreservingCryptoKey(value))
      return key
    })
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.#track(() => {
      this.#ensureWritable()
      this.#store.rows.delete(String(key))
      return undefined
    })
  }

  clear(): IDBRequest<undefined> {
    return this.#track(() => {
      this.#ensureWritable()
      this.#store.rows.clear()
      return undefined
    })
  }
}

class MockIdbTransaction {
  readonly mode: IDBTransactionMode
  readonly durability: IDBTransactionDurability
  error: DOMException | null = null
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null

  readonly #db: StoredDb
  readonly #snapshots = new Map<string, Map<string, unknown>>()
  #pending = 0
  #aborted = false
  #finished = false
  #scheduledCheck = false

  constructor(
    db: StoredDb,
    storeNames: readonly string[],
    mode: IDBTransactionMode,
    durability: IDBTransactionDurability
  ) {
    this.#db = db
    this.mode = mode
    this.durability = durability
    if (mode !== 'readonly') {
      for (const name of storeNames) {
        const s = db.stores.get(name)
        if (s !== undefined) {
          const snap = new Map<string, unknown>()
          for (const [k, v] of s.rows) snap.set(k, clonePreservingCryptoKey(v))
          this.#snapshots.set(name, snap)
        }
      }
    }
    this.#scheduleCheck()
  }

  #scheduleCheck(): void {
    if (this.#scheduledCheck || this.#finished) return
    this.#scheduledCheck = true
    const step = (remaining: number): void => {
      queueMicrotask(() => {
        if (this.#finished || this.#aborted) {
          this.#scheduledCheck = false
          return
        }
        if (this.#pending > 0) {
          this.#scheduledCheck = false
          return
        }
        if (remaining > 1) {
          step(remaining - 1)
          return
        }
        this.#scheduledCheck = false
        this.#finished = true
        this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete'))
      })
    }
    step(12)
  }

  objectStore(name: string): IDBObjectStore {
    if (this.#aborted || this.#finished) {
      throw new DOMException('Transaction inactive', 'TransactionInactiveError')
    }
    const store = this.#db.stores.get(name)
    if (store === undefined) throw new DOMException(`Store ${name} missing`, 'NotFoundError')
    return new MockIdbObjectStore(name, store, this.mode, (fn) => {
      this.#pending += 1
      return makeRequest(fn, (ok, err) => {
        this.#pending -= 1
        if (!ok && !this.#aborted) {
          this.error = err instanceof DOMException ? err : new DOMException('Failed', 'AbortError')
          this.onerror?.call(this as unknown as IDBTransaction, new Event('error'))
          this.abort()
          return
        }
        this.#scheduleCheck()
      })
    }) as unknown as IDBObjectStore
  }

  abort(): void {
    if (this.#finished || this.#aborted) return
    this.#aborted = true
    this.#finished = true
    for (const [name, snap] of this.#snapshots) {
      const store = this.#db.stores.get(name)
      if (store !== undefined) store.rows = snap
    }
    queueMicrotask(() => {
      this.onabort?.call(this as unknown as IDBTransaction, new Event('abort'))
    })
  }
}

class MockIdbDatabase {
  readonly name: string
  readonly #stored: StoredDb
  #closed = false
  onversionchange: ((this: IDBDatabase, ev: IDBVersionChangeEvent) => unknown) | null = null

  constructor(name: string, stored: StoredDb) {
    this.name = name
    this.#stored = stored
    stored.handles.add(this)
  }

  get objectStoreNames(): DOMStringList {
    const names = [...this.#stored.stores.keys()]
    return {
      length: names.length,
      contains: (name: string) => this.#stored.stores.has(name),
      item: (index: number) => names[index] ?? null,
      [Symbol.iterator]: function* () {
        yield* names
      },
    } as unknown as DOMStringList
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    const keyPath = typeof options?.keyPath === 'string' ? options.keyPath : 'id'
    const storeData: StoredStoreData = {
      keyPath,
      indexes: new Map(),
      rows: new Map(),
    }
    this.#stored.stores.set(name, storeData)
    return new MockIdbObjectStore(name, storeData, 'versionchange', (fn) =>
      makeRequest(fn)
    ) as unknown as IDBObjectStore
  }

  transaction(
    storeNames: string | string[],
    mode: IDBTransactionMode = 'readonly',
    options?: IDBTransactionOptions
  ): IDBTransaction {
    if (this.#closed) {
      throw new DOMException('Database connection is closing or closed', 'InvalidStateError')
    }
    const list = Array.isArray(storeNames) ? storeNames : [storeNames]
    for (const name of list) {
      if (!this.#stored.stores.has(name)) {
        throw new DOMException(`Store ${name} does not exist`, 'NotFoundError')
      }
    }
    const durability: IDBTransactionDurability = options?.durability ?? 'default'
    return new MockIdbTransaction(this.#stored, list, mode, durability) as unknown as IDBTransaction
  }

  close(): void {
    this.#closed = true
    this.#stored.handles.delete(this)
  }
}

export interface TestVaultIdbFactory extends IDBFactory {
  readonly deletedDatabases: string[]
  hasDatabase(name: string): boolean
  peekStoreRows(dbName: string, storeName: string): Map<string, unknown>
}

export function createTestVaultIndexedDb(options?: {
  readonly forceRelaxedDurability?: boolean | undefined
}): TestVaultIdbFactory {
  const dbs = new Map<string, StoredDb>()
  const deletedDatabases: string[] = []

  return {
    deletedDatabases,
    hasDatabase: (name: string) => dbs.has(name),
    peekStoreRows: (dbName: string, storeName: string) =>
      dbs.get(dbName)?.stores.get(storeName)?.rows ?? new Map(),

    open(name: string, version = 1): IDBOpenDBRequest {
      const req: {
        result: IDBDatabase
        error: DOMException | null
        transaction: IDBTransaction | null
        onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null
        onsuccess: ((this: IDBOpenDBRequest, ev: Event) => unknown) | null
        onerror: ((this: IDBOpenDBRequest, ev: Event) => unknown) | null
        onblocked: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null
      } = {
        result: undefined as unknown as IDBDatabase,
        error: null,
        transaction: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }

      queueMicrotask(() => {
        let existing = dbs.get(name)
        const isNew = existing === undefined
        const needsUpgrade = isNew || version > existing!.version
        if (!existing) {
          existing = { version, stores: new Map(), handles: new Set() }
          dbs.set(name, existing)
        } else if (needsUpgrade) {
          for (const h of [...existing.handles]) {
            h.onversionchange?.call(
              h as unknown as IDBDatabase,
              new Event('versionchange') as IDBVersionChangeEvent
            )
          }
          existing.version = version
        }

        const handle = new MockIdbDatabase(name, existing)
        if (options?.forceRelaxedDurability) {
          const origTx = handle.transaction.bind(handle)
          handle.transaction = (stores, mode, _opts) => origTx(stores, mode, { durability: 'relaxed' })
        }
        req.result = handle as unknown as IDBDatabase

        let upgradeAborted = false
        if (needsUpgrade) {
          req.transaction = {
            abort() {
              upgradeAborted = true
              handle.close()
              if (isNew) dbs.delete(name)
            },
          } as unknown as IDBTransaction
          req.onupgradeneeded?.call(
            req as unknown as IDBOpenDBRequest,
            new Event('upgradeneeded') as IDBVersionChangeEvent
          )
          req.transaction = null
        }

        if (upgradeAborted) {
          req.error = new DOMException('Upgrade aborted', 'AbortError')
          req.onerror?.call(req as unknown as IDBOpenDBRequest, new Event('error'))
          return
        }

        req.onsuccess?.call(req as unknown as IDBOpenDBRequest, new Event('success'))
      })

      return req as unknown as IDBOpenDBRequest
    },

    deleteDatabase(name: string): IDBOpenDBRequest {
      deletedDatabases.push(name)
      const req: {
        result: undefined
        error: DOMException | null
        onsuccess: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null
        onerror: ((this: IDBOpenDBRequest, ev: Event) => unknown) | null
        onblocked: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null
      } = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }
      const existing = dbs.get(name)
      if (existing) {
        for (const h of [...existing.handles]) {
          h.onversionchange?.call(
            h as unknown as IDBDatabase,
            new Event('versionchange') as IDBVersionChangeEvent
          )
        }
      }
      // Run on a macrotask after any synchronous tombstone transactions started by versionchange/wipe listeners commit.
      setTimeout(() => {
        dbs.delete(name)
        req.onsuccess?.call(
          req as unknown as IDBOpenDBRequest,
          new Event('success') as IDBVersionChangeEvent
        )
      }, 0)
      return req as unknown as IDBOpenDBRequest
    },

    async databases(): Promise<IDBDatabaseInfo[]> {
      return [...dbs.entries()].map(([name, info]) => ({ name, version: info.version }))
    },

    cmp(first: unknown, second: unknown): number {
      return String(first).localeCompare(String(second))
    },
  }
}

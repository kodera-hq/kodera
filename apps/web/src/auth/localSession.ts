// Explicit logout discards the console's local customer data. Storage is
// best-effort: browser policy must not prevent in-memory logout or navigation.

/**
 * Espace's encrypted device vault (`features/espace/matrix/encryptedCache.ts`) and legacy
 * timeline database (`features/espace/matrix/timelineCache.ts`). Named here as lightweight string
 * constants, never statically imported, so the entry bundle stays lean and sign-out / principal
 * switches always purge both databases whether or not Espace was opened in this tab.
 */
export const ESPACE_VAULT_DATABASE = 'kodera.espace-vault.v1'
export const ESPACE_VAULT_WIPE_CHANNEL = 'kodera.espace-vault.wipe.v1'
export const ESPACE_TIMELINE_DATABASE = 'kodera-espace-timelines'

/**
 * Returns `ESPACE_VAULT_WIPE_CHANNEL` in browser runtimes and scopes it per Vitest worker/file in
 * Node test threads, where `node:worker_threads` shares `BroadcastChannel` across parallel test
 * workers running independent JSDOM sessions.
 */
export function espaceVaultWipeChannelName(): string {
  const runtime = globalThis as {
    __vitest_worker__?: { filepath?: string; ctx?: { workerId?: number } }
    process?: { env?: Record<string, string | undefined> }
  }
  const workerScope =
    runtime.__vitest_worker__?.filepath ??
    (runtime.__vitest_worker__?.ctx?.workerId !== undefined
      ? String(runtime.__vitest_worker__.ctx.workerId)
      : undefined) ??
    runtime.process?.env?.['VITEST_WORKER_ID'] ??
    runtime.process?.env?.['VITEST_POOL_ID']
  return workerScope ? `${ESPACE_VAULT_WIPE_CHANNEL}:${workerScope}` : ESPACE_VAULT_WIPE_CHANNEL
}

/**
 * Collaborative document Yjs offline buffer prefix and registry key
 * (`features/docs/collabSession.ts`). Named here without importing Yjs or `y-indexeddb` so the
 * entry bundle never pulls collaborative editor code on initial page load.
 */
export const DOCS_COLLAB_DATABASE = 'kodera-docs-collab'
export const DOCS_COLLAB_DATABASE_PREFIX = 'kodera-docs-yjs:'
export const DOCS_COLLAB_REGISTRY_KEY = 'kodera.web.docs-collab-dbs'
export const PUSH_COPY_CACHE = 'kodera-push-copy-v1'

const cleanupListeners = new Set<() => void>()
const espaceVaultCleanupListeners = new Set<() => void>()
const docsCollabCleanupListeners = new Set<() => void>()

/**
 * Registers an in-memory teardown hook (for example closing an open `y-indexeddb` handle) before
 * IndexedDB databases are deleted on sign-out. Returns an unsubscribe function.
 */
export function registerLocalSessionCleanup(listener: () => void): () => void {
  cleanupListeners.add(listener)
  return () => {
    cleanupListeners.delete(listener)
  }
}

/**
 * Registers an Espace vault cryptographic teardown hook invoked on sign-out, principal switch,
 * session termination, and GDPR Art. 17 erasure before IndexedDB deletion.
 */
export function registerEspaceVaultCleanup(listener: () => void): () => void {
  espaceVaultCleanupListeners.add(listener)
  return () => {
    espaceVaultCleanupListeners.delete(listener)
  }
}

/**
 * Registers a collaborative Yjs IndexedDB handle teardown hook invoked before `kodera-docs-yjs:*`
 * databases are deleted on sign-out, principal switch, session termination, or GDPR erasure.
 */
export function registerDocsCollabCleanup(listener: () => void): () => void {
  docsCollabCleanupListeners.add(listener)
  return () => {
    docsCollabCleanupListeners.delete(listener)
  }
}

function readRegisteredDocsDatabases(): string[] {
  try {
    const raw = window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.startsWith(DOCS_COLLAB_DATABASE_PREFIX)
    )
  } catch {
    return []
  }
}

export function purgeEspaceVaultDatabases(): void {
  for (const listener of [...espaceVaultCleanupListeners]) {
    try {
      listener()
    } catch {
      // Never block vault wipe on a listener error.
    }
  }
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(espaceVaultWipeChannelName())
      channel.postMessage({ type: 'wipe' })
      channel.close()
    }
  } catch {
    // Ignore restricted BroadcastChannel environments.
  }
  try {
    const idb = globalThis.indexedDB
    if (idb !== undefined && typeof idb.deleteDatabase === 'function') {
      idb.deleteDatabase(ESPACE_VAULT_DATABASE)
      idb.deleteDatabase(ESPACE_TIMELINE_DATABASE)
    }
  } catch {
    // Ignore restricted IndexedDB environments.
  }
}

export function purgeDocsCollabDatabases(clearRegistryKey = false): void {
  for (const listener of [...docsCollabCleanupListeners]) {
    try {
      listener()
    } catch {
      // Never block docs database purge on a listener error.
    }
  }
  const docsDatabases = readRegisteredDocsDatabases()
  if (clearRegistryKey) {
    try {
      if (window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY) !== null) {
        window.localStorage.removeItem(DOCS_COLLAB_REGISTRY_KEY)
      }
    } catch {
      // Ignore restricted localStorage environments.
    }
  }
  try {
    const idb = globalThis.indexedDB
    if (idb !== undefined && typeof idb.deleteDatabase === 'function') {
      idb.deleteDatabase(DOCS_COLLAB_DATABASE)
      for (const dbName of docsDatabases) {
        idb.deleteDatabase(dbName)
      }
      if (typeof idb.databases === 'function') {
        void idb
          .databases()
          .then((entries) => {
            for (const entry of entries) {
              if (
                typeof entry.name === 'string' &&
                entry.name.startsWith(DOCS_COLLAB_DATABASE_PREFIX) &&
                !docsDatabases.includes(entry.name)
              ) {
                try {
                  idb.deleteDatabase(entry.name)
                } catch {
                  // Ignore late IndexedDB refusal.
                }
              }
            }
          })
          .catch(() => {
            // Ignore unsupported/refused databases() enumeration.
          })
      }
    }
  } catch {
    // No IndexedDB here (a private window may refuse it): nothing was kept either.
  }
}

export interface ClearLocalSessionOptions {
  readonly skipBrowserPushCleanup?: boolean | undefined
}

export function clearLocalSessionStorage(options?: ClearLocalSessionOptions): void {
  for (const listener of [...cleanupListeners]) {
    try {
      listener()
    } catch {
      // Never block sign-out on a cleanup listener error.
    }
  }

  if (options?.skipBrowserPushCleanup !== true) {
    try {
      void globalThis.caches?.delete(PUSH_COPY_CACHE)?.catch(() => undefined)
    } catch {
      // Ignore restricted CacheStorage environments.
    }

    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof window !== 'undefined' &&
      'PushManager' in window &&
      'Notification' in window
    ) {
      try {
        void navigator.serviceWorker
          .getRegistration(import.meta.env.BASE_URL)
          .then((reg) => reg?.pushManager.getSubscription())
          .then((sub) => sub?.unsubscribe())
          .catch(() => undefined)
      } catch {
        // Best-effort browser push unsubscribe.
      }
    }
  }

  purgeEspaceVaultDatabases()
  purgeDocsCollabDatabases(false)

  for (const kind of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = window[kind]
      for (const key of Object.keys(storage)) {
        if (
          key.startsWith('kodera.web.') ||
          key.startsWith('kodera.profile.') ||
          key.startsWith('kodera.muted-channels.') ||
          key.startsWith('kodera:drafts:') ||
          key.startsWith('kodera:last-channel:') ||
          key.startsWith('order-draft:') ||
          key.startsWith('order-draft-latest:')
        ) {
          storage.removeItem(key)
        }
      }
    } catch {
      // No exception details: browser storage may carry personal form values.
    }
  }
}

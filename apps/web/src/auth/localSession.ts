// Explicit logout discards the console's local customer data. Storage is
// best-effort: browser policy must not prevent in-memory logout or navigation.

/**
 * Espace's device cache of channel messages (`features/espace/matrix/timelineCache.ts`). Named
 * here, not imported, so signing out never loads Espace's code; a test keeps the names equal.
 */
export const ESPACE_TIMELINE_DATABASE = 'kodera-espace-timelines'

/**
 * Collaborative document Yjs offline buffer prefix and registry key
 * (`features/docs/collabSession.ts`). Named here without importing Yjs or `y-indexeddb` so the
 * entry bundle never pulls collaborative editor code on initial page load.
 */
export const DOCS_COLLAB_DATABASE = 'kodera-docs-collab'
export const DOCS_COLLAB_DATABASE_PREFIX = 'kodera-docs-yjs:'
export const DOCS_COLLAB_REGISTRY_KEY = 'kodera.web.docs-collab-dbs'

const cleanupListeners = new Set<() => void>()

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

export function clearLocalSessionStorage(): void {
  for (const listener of [...cleanupListeners]) {
    try {
      listener()
    } catch {
      // Never block sign-out on a cleanup listener error.
    }
  }
  cleanupListeners.clear()

  const docsDatabases = readRegisteredDocsDatabases()

  try {
    // Deleted whether or not Espace or Docs was opened in this tab; another tab holding it open
    // delays the deletion until it closes, and it happens then.
    const idb = globalThis.indexedDB
    if (idb !== undefined) {
      idb.deleteDatabase(ESPACE_TIMELINE_DATABASE)
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

  for (const kind of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = window[kind]
      for (const key of Object.keys(storage)) {
        if (
          key.startsWith('kodera.web.') ||
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

// Explicit logout discards the console's local customer data. Storage is
// best-effort: browser policy must not prevent in-memory logout or navigation.

/**
 * Espace's device cache of channel messages (`features/espace/matrix/timelineCache.ts`). Named
 * here, not imported, so signing out never loads Espace's code; a test keeps the names equal.
 */
export const ESPACE_TIMELINE_DATABASE = 'kodera-espace-timelines'

export function clearLocalSessionStorage(): void {
  try {
    // Deleted whether or not Espace was opened in this tab; another tab holding it open delays
    // the deletion until it closes, and it happens then.
    globalThis.indexedDB?.deleteDatabase(ESPACE_TIMELINE_DATABASE)
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

// Explicit logout discards the console's local customer data. Storage is
// best-effort: browser policy must not prevent in-memory logout or navigation.
export function clearLocalSessionStorage(): void {
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

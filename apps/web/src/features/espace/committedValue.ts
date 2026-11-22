/** A view-local external store: only committed lifecycle work publishes values. */
export function createCommittedValue<T>(initial: T) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit(next: T) {
      if (Object.is(current, next)) return
      current = next
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try {
          listener()
        } catch {
          /* A removed/throwing observer cannot skip another. */
        }
      }
    },
  }
}

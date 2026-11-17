import { registerLocalSessionCleanup } from '../../auth/localSession'

const listeners = new Set<() => void>()
/** No backup metadata is persisted; retire live workers and transient displays on erasure too. */
export function registerSecuritySessionCleanup(listener: () => void): () => void {
  const unregister = registerLocalSessionCleanup(listener)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    unregister()
  }
}
export function clearSecuritySessions(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* Retirement continues for every worker and display. */
    }
  }
}

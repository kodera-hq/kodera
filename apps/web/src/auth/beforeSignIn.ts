// Only deliberate reauthentication boundaries dispatch this synchronous seam.
const listeners = new Set<() => void>()

export function onBeforeSignIn(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function beforeSignIn(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* A failed draft save must not block sign-in. */
    }
  }
}

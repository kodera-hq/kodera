// The browser's own connectivity signal (docs/specs/00-shell-and-login.md's
// "Offline" column, every screen): `navigator.onLine` plus the `online` /
// `offline` window events, which is what flips the moment the connection
// actually drops rather than waiting for the next failed request. Shared
// between `login` (submit disabled, banner) and the shell's status banner
// precedence (offline outranks everything else) rather than each polling
// its own listener.

import { useEffect, useState } from 'react'

function isOnline(): boolean {
  // `navigator.onLine` does not exist in the Node test environment; a test
  // that never touched this module would still trip over it through a
  // component import, so this reads `true` there rather than throwing.
  return typeof navigator === 'undefined' || navigator.onLine
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(isOnline)

  useEffect(() => {
    const update = () => setOnline(isOnline())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return online
}

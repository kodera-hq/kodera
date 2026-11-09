// Breaks the one loop the route error screen could otherwise start: a 401,
// « Se reconnecter », a successful sign-in, and a 401 again on the way back —
// a server that keeps refusing the new session would send the person round
// forever. The screen marks the round trip before it leaves; a page that then
// loads clears the mark (`./org-route.tsx`), and a 401 that finds the mark
// still set offers signing out and support instead of another round.
//
// `sessionStorage`, like the return-to path it travels with
// (`../auth/return-to.ts`): it has to survive the full-page redirect, and
// sign-out's cleanup (`../auth/localSession.ts`) removes it with the rest of
// the `kodera.web.` keys.

const KEY = 'kodera.web.session.reauthenticatingFromError'

export function markReauthenticationFromError(): void {
  try {
    window.sessionStorage.setItem(KEY, '1')
  } catch {
    // Storage refused: the screen still works, only the loop guard is lost.
  }
}

export function reauthenticationFromErrorPending(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) !== null
  } catch {
    return false
  }
}

export function clearReauthenticationFromError(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

// Where to send the browser back to once the OIDC round-trip completes. The
// realm discovered from the deep link the person actually wanted, not a
// fixed destination — `sessionStorage`, the same tier `oidc.ts`'s own PKCE
// interaction state uses, and cleared on read so a second, unrelated
// callback never reuses a stale one.

const RETURN_TO_KEY = 'kodera.web.auth.returnTo'

export function rememberReturnTo(path: string): void {
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, path)
  } catch {
    // Storage policy or quota must not crash sign-in or callback redirects.
  }
}

export function hasReturnTo(): boolean {
  try {
    const path = window.sessionStorage.getItem(RETURN_TO_KEY)
    return path !== null && path.length > 0
  } catch {
    return false
  }
}

/** Reads and clears the remembered path. `/` when nothing was recorded —
 * a callback reached with no prior `rememberReturnTo` is not a state this
 * unit expects, but it is not a reason to throw out of a redirect either. */
export function consumeReturnTo(): string {
  try {
    const path = window.sessionStorage.getItem(RETURN_TO_KEY)
    window.sessionStorage.removeItem(RETURN_TO_KEY)
    return path ?? '/'
  } catch {
    return '/'
  }
}

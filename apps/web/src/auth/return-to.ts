// Where to send the browser back to once the OIDC round-trip completes. The
// realm discovered from the deep link the person actually wanted, not a
// fixed destination — `sessionStorage`, the same tier `oidc.ts`'s own PKCE
// interaction state uses, and cleared on read so a second, unrelated
// callback never reuses a stale one.

const RETURN_TO_KEY = 'kodera.web.auth.returnTo'

export function rememberReturnTo(path: string): void {
  window.sessionStorage.setItem(RETURN_TO_KEY, path)
}

/** Reads and clears the remembered path. `/` when nothing was recorded —
 * a callback reached with no prior `rememberReturnTo` is not a state this
 * unit expects, but it is not a reason to throw out of a redirect either. */
export function consumeReturnTo(): string {
  const path = window.sessionStorage.getItem(RETURN_TO_KEY)
  window.sessionStorage.removeItem(RETURN_TO_KEY)
  return path ?? '/'
}

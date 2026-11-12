// A workspace invite link's code (Core API 0.43.0, `redeemWorkspaceInvite`), read from the
// address's fragment, which no server receives, then removed from the address bar and the
// history entry at once. It lives in memory only, like an invitation's secret (`entry.ts`).

const CODE = /^[A-Za-z0-9_-]{16,128}$/u

/** The code in `hash`, or null when there is none or it is not one Core could have issued. */
export function codeOf(hash: string): string | null {
  let value: string
  try {
    value = decodeURIComponent(hash.replace(/^#/u, ''))
  } catch {
    return null
  }
  return CODE.test(value) ? value : null
}

/** Reads the code, and takes it out of the address so it is neither bookmarked nor shared. */
export function takeJoinCode(
  location: Location = window.location,
  history: History = window.history
): string | null {
  const code = codeOf(location.hash)
  if (location.hash !== '')
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  return code
}

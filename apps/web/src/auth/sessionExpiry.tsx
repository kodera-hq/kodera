// `session-expiry` (docs/specs/00-shell-and-login.md §4.7): a silent refresh
// on every focus and every 60 s while the tab is visible; the countdown
// warning appears only in the final 120 seconds of the access token lifetime.
// On expiry the console stashes the registered form values,
// re-authenticates in place, and restores it — see `STASH_STORAGE_KEY`
// below for why that stash is `sessionStorage`, not the plain in-memory
// value the spec's own wording might suggest. `useSessionExpiring()` is
// what the shell's banner precedence (`src/app/bannerPrecedence.ts`) reads
// to rank this above an incident and below only "offline".

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { trackSessionExpiryDialogShown } from '../app/analytics'
import { useAuth } from './AuthProvider'
import { authAdapter } from './oidc'
import { rememberReturnTo } from './return-to'
import { beforeSignIn, onBeforeSignIn } from './beforeSignIn'

const SILENT_REFRESH_INTERVAL_MS = 60_000

export type StashedFormState = Record<string, unknown>

// §4.7's own re-authentication round trip is a FULL page navigation to
// `id.kodera.io` and back (the same one `src/auth/oidc.ts`'s
// `signIn`/`handleCallback` drive) — the entire JS heap, this provider's
// React state included, is torn down and rebuilt from nothing partway
// through it. A plain in-memory `Map` cannot survive that; `sessionStorage`
// can, and is the SAME tier `src/auth/return-to.ts` and oidc-client-ts's own
// PKCE interaction state already trust for exactly this reason. It is not
// `localStorage` — the one store §4.7 rules out, because it outlives the
// browser session rather than ending with it — so "never in localStorage"
// and "must survive the redirect" are both satisfied at once.
const STASH_STORAGE_KEY = 'kodera.web.session.formStash'

function readStash(): Record<string, StashedFormState> {
  const raw = window.sessionStorage.getItem(STASH_STORAGE_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, StashedFormState>)
      : {}
  } catch {
    return {}
  }
}

function writeStash(all: Record<string, StashedFormState>): void {
  window.sessionStorage.setItem(STASH_STORAGE_KEY, JSON.stringify(all))
}

interface SessionExpiryContextValue {
  /** Whether the countdown dialog should be showing. */
  expiring: boolean
  remainingS: number
  extend: () => void
  /** Hide the warning immediately; renewal continues independently. */
  dismiss: () => void
  /** T−2 min's deliberate choice: end the session now, no restore — a
   * person who chooses this meant to leave. */
  signOutNow: () => void
  /** T−0's one action (§9: "Dialog, single action 'Se reconnecter'"): the
   * refresh has already failed, so this is what actually re-authenticates
   * in place and restores the stashed form state. */
  signInAgain: () => void
  /** The round trip itself, with no dialog analytics: stash, remember the
   * current page, send the browser to sign in. `realmHint` is the realm to
   * fall back on when no session, live or past, names one — the route error
   * screen's case (`src/app/RouteError.tsx`), where the organisation slug in
   * the URL is all that is left. Returns false when no realm is known and
   * nothing was started. */
  reauthenticate: (realmHint?: string) => boolean
  /** Stores arbitrary form values under a screen-chosen key, read back once
   * by `useFormStash` after the round trip — `sessionStorage`-backed so it
   * survives the full-page redirect (never `localStorage`, which §4.7
   * rules out; see the module comment on `STASH_STORAGE_KEY`). */
  stash: (key: string, values: StashedFormState) => void
  takeStashed: (key: string) => StashedFormState | undefined
  /** Registers a callback fired synchronously, just before `signInAgain`
   * starts the round trip — the mounted screen's own last chance to read
   * its current field values (off the DOM, not off `Form`'s own state,
   * which nothing outside a `Form` can reach) and `stash` them. Returns an
   * unsubscribe function, the same shape `AuthAdapter.onExpiring` uses. */
  onBeforeSignInAgain: (callback: () => void) => () => void
}

const SessionExpiryContext = createContext<SessionExpiryContextValue | null>(null)

export function SessionExpiryProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [remainingS, setRemainingS] = useState(0)
  const [expiring, setExpiring] = useState(false)
  const [countdownOwner, setCountdownOwner] = useState(auth.user)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [warningDismissed, setWarningDismissed] = useState(false)
  const dismissedDeadline = useRef<number | undefined>(undefined)
  const deadline = useRef<number | undefined>(undefined)
  const generation = useRef(0)
  // The realm the LAST live session used, kept even once `auth.user` is
  // cleared: re-authenticating needs to know which realm to send the person
  // back to, and by the time `signInAgain` runs there may be no session left
  // to read it off of any more (a real failed refresh clears it the same
  // way `authAdapter.signOut()` does, `src/auth/testHooks.ts`).
  const lastRealmRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (auth.user !== undefined) lastRealmRef.current = auth.user.realm
  }, [auth.user])

  const closeCountdown = useCallback(() => {
    deadline.current = undefined
    setExpiring(false)
    setRemainingS(0)
    setRefreshFailed(false)
    dismissedDeadline.current = undefined
    setWarningDismissed(false)
  }, [])

  const beginCountdown = useCallback(
    (failed = false) => {
      // Use the credential's deadline, including after suspended timers resume.
      // An unknown or already absent credential cannot promise extra access time.
      deadline.current =
        authAdapter.getAccessToken() === undefined ? undefined : authAdapter.getExpiresAt()
      const seconds = Math.max(0, Math.ceil(((deadline.current ?? Date.now()) - Date.now()) / 1000))
      if (seconds > 120) {
        closeCountdown()
        return
      }
      if (dismissedDeadline.current !== deadline.current) setWarningDismissed(false)
      setRemainingS(seconds)
      setRefreshFailed(failed)
      setCountdownOwner(auth.user)
      setExpiring(true)
    },
    [auth.user, closeCountdown]
  )

  const requestRenewal = useCallback(
    async (recordExtension = false) => {
      if (!auth.isAuthenticated) return
      const current = generation.current
      const renewed = await authAdapter.renew().catch(() => false)
      if (generation.current !== current) return
      if (renewed) {
        closeCountdown()
        if (recordExtension) trackSessionExpiryDialogShown('extended')
      } else {
        beginCountdown(true)
      }
    },
    [auth.isAuthenticated, closeCountdown, beginCountdown]
  )

  useEffect(() => {
    generation.current += 1
    if (!auth.isAuthenticated) return
    let active = true
    const unsubscribeExpiring = authAdapter.onExpiring(() => {
      if (active) beginCountdown()
    })
    const unsubscribeRenewed = authAdapter.onRenewed(() => {
      if (active) closeCountdown()
    })
    const unsubscribeFailed = authAdapter.onRenewalFailed(() => {
      if (active) beginCountdown(true)
    })
    return () => {
      active = false
      generation.current += 1
      unsubscribeExpiring()
      unsubscribeRenewed()
      unsubscribeFailed()
    }
  }, [auth.isAuthenticated, auth.user?.realm, beginCountdown, closeCountdown])

  useEffect(() => {
    if (!auth.isAuthenticated) return
    const check = () => {
      if (document.visibilityState === 'visible') void requestRenewal()
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    const interval = window.setInterval(check, SILENT_REFRESH_INTERVAL_MS)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
      window.clearInterval(interval)
    }
  }, [auth.isAuthenticated, requestRenewal])

  useEffect(() => {
    if (!expiring || !auth.isAuthenticated || countdownOwner !== auth.user) return
    const update = () => {
      setRemainingS(Math.max(0, Math.ceil(((deadline.current ?? Date.now()) - Date.now()) / 1000)))
    }
    const timer = window.setInterval(update, 1000)
    // Resume should show elapsed wall-clock time before a network request ends.
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [expiring, auth.isAuthenticated, auth.user, countdownOwner])

  useEffect(() => {
    if (remainingS === 0 && expiring) {
      trackSessionExpiryDialogShown(refreshFailed ? 'signed-out' : 'ignored')
    }
  }, [remainingS, expiring, refreshFailed])

  const extend = useCallback(() => {
    void requestRenewal(true)
  }, [requestRenewal])

  const dismiss = useCallback(() => {
    // Keep the clock alive so true expiry still requires reauthentication.
    // A failed background renewal cannot reopen this credential's warning.
    dismissedDeadline.current = deadline.current
    setWarningDismissed(true)
    void requestRenewal(true)
  }, [requestRenewal])

  const signOutNow = useCallback(() => {
    trackSessionExpiryDialogShown('signed-out')
    // The account menu and expiry dialog share the same cache/storage cleanup.
    // OrgLayout removes its private content as soon as this clears React auth.
    void auth.signOut().catch(() => {})
  }, [auth])

  const reauthenticate = useCallback((realmHint?: string): boolean => {
    const realm = authAdapter.getUser()?.realm ?? lastRealmRef.current ?? realmHint
    if (realm === undefined) return false
    // Every mounted screen's last chance to stash what it holds, before
    // anything else about the page changes.
    beforeSignIn()
    // Same screen, form intact (§4.7): the round trip has to come back to
    // exactly where it left off, the same `returnTo` mechanism a fresh
    // sign-in uses (`src/app/org-route.tsx`'s `beforeLoad`, which remembers
    // the ROUTER's own relative `location.href`, e.g. `/acme-sa/home` — never
    // `window.location.href`'s absolute form, which `router.navigate({
    // href })` does not resolve the same way on the round trip back).
    rememberReturnTo(window.location.pathname + window.location.search)
    void authAdapter.signIn(realm)
    return true
  }, [])

  const signInAgain = useCallback(() => {
    trackSessionExpiryDialogShown('signed-out')
    reauthenticate()
  }, [reauthenticate])

  const stash = useCallback((key: string, values: StashedFormState) => {
    const all = readStash()
    all[key] = values
    writeStash(all)
  }, [])

  const takeStashed = useCallback((key: string) => {
    const all = readStash()
    const value = all[key]
    if (value === undefined) return undefined
    delete all[key]
    writeStash(all)
    return value
  }, [])

  const onBeforeSignInAgain = onBeforeSignIn

  const value = useMemo<SessionExpiryContextValue>(
    () => ({
      expiring:
        auth.isAuthenticated &&
        countdownOwner === auth.user &&
        expiring &&
        !(remainingS > 0 && warningDismissed),
      remainingS,
      extend,
      dismiss,
      signOutNow,
      signInAgain,
      reauthenticate,
      stash,
      takeStashed,
      onBeforeSignInAgain,
    }),
    [
      auth.isAuthenticated,
      auth.user,
      countdownOwner,
      warningDismissed,
      expiring,
      remainingS,
      extend,
      dismiss,
      signOutNow,
      signInAgain,
      reauthenticate,
      stash,
      takeStashed,
      onBeforeSignInAgain,
    ]
  )

  return <SessionExpiryContext.Provider value={value}>{children}</SessionExpiryContext.Provider>
}

function useSessionExpiryContext(): SessionExpiryContextValue {
  const value = useContext(SessionExpiryContext)
  if (value === null) {
    throw new Error('useSessionExpiring/useFormStash must be used within a SessionExpiryProvider')
  }
  return value
}

/** What the shell's banner precedence reads (`src/app/bannerPrecedence.ts`):
 * true from the moment the countdown starts until it is either extended or
 * the person signs in again. */
export function useSessionExpiring(): boolean {
  return useSessionExpiryContext().expiring
}

/** The sign-in round trip without the dialog: what the route error screen
 * uses for a 401, so it does not report itself as the expiry dialog. */
export function useReauthenticate(): (realmHint?: string) => boolean {
  return useSessionExpiryContext().reauthenticate
}

export function useSessionExpiryDialog() {
  const { expiring, remainingS, extend, dismiss, signOutNow, signInAgain } =
    useSessionExpiryContext()
  return { expiring, remainingS, extend, dismiss, signOutNow, signInAgain }
}

/** A screen stashes its own form values under a key it chooses (its route
 * path is a reasonable one) before the round trip, and reads them back once
 * mounted again — never through `localStorage` (§4.7). Registers its
 * `onSave` with `onBeforeSignInAgain` for the caller, and cleans up on
 * unmount, so a screen only has to say what to save, not when. */
export function useFormStash(onSave: () => void): void {
  const { onBeforeSignInAgain } = useSessionExpiryContext()
  useEffect(() => onBeforeSignInAgain(onSave), [onBeforeSignInAgain, onSave])
}

export function useTakeStashed(key: string): StashedFormState | undefined {
  const { takeStashed } = useSessionExpiryContext()
  const [value] = useState(() => takeStashed(key))
  return value
}

export function useStash(): (key: string, values: StashedFormState) => void {
  return useSessionExpiryContext().stash
}

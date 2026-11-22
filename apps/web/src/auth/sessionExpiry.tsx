// `session-expiry` (docs/specs/00-shell-and-login.md §4.7): one deadline timer per
// credential, plus a single-flight renewal when focus or visibility returns. A short
// cooldown coalesces paired browser events; no periodic renewal loop is needed.
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

/** Renew one minute before expiry, without immediately renewing short-lived credentials. */
export const RENEWAL_LEAD_MS = 60_000
/** Minimum wait for deadline scheduling and retries after a failed attempt. */
export const RENEWAL_RETRY_MS = 15_000
/** Coalesce focus and visibility events, including during initial mount. */
const RENEWAL_COOLDOWN_MS = 2_000
/** `setTimeout` overflows above this delay; longer lifetimes are waited for in steps. */
const LONGEST_TIMER_MS = 2 ** 31 - 1

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
  /** Registers a callback fired synchronously, just before `signInAgain`
   * starts the round trip — the mounted screen's own last chance to read
   * its current field values and persist them. Returns an unsubscribe
   * function, the same shape `AuthAdapter.onExpiring` uses. */
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
  const renewalInFlight = useRef<Promise<void> | undefined>(undefined)
  const lastRenewal = useRef(0)
  const lastFocusEvent = useRef<{ type: string; at: number } | undefined>(undefined)
  useEffect(() => {
    lastRenewal.current = Date.now()
  }, [])
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
      if (renewalInFlight.current !== undefined) return renewalInFlight.current
      const current = generation.current
      const attempt = (async () => {
        const renewed = await authAdapter.renew().catch(() => false)
        if (generation.current !== current) return
        if (renewed) {
          closeCountdown()
          if (recordExtension) trackSessionExpiryDialogShown('extended')
        } else {
          beginCountdown(true)
        }
      })()
      renewalInFlight.current = attempt
      try {
        await attempt
      } finally {
        lastRenewal.current = Date.now()
        renewalInFlight.current = undefined
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
      if (active) {
        lastRenewal.current = Date.now()
        closeCountdown()
      }
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

  // Credential rotation reschedules its deadline. Focus renews even a long-lived token so the
  // current-user fence can revalidate authority; early focus is deferred through the cooldown.
  useEffect(() => {
    if (!auth.isAuthenticated) return
    let timer: number | undefined
    let focusTimer: number | undefined
    let active = true
    const schedule = () => {
      window.clearTimeout(timer)
      if (!active) return
      const expiresAt = authAdapter.getExpiresAt()
      if (expiresAt === undefined) return
      const delay = Math.max(RENEWAL_RETRY_MS, expiresAt - Date.now() - RENEWAL_LEAD_MS)
      timer = window.setTimeout(
        () => {
          // Very long lifetimes are waited for in bounded steps, never renewed early.
          if (expiresAt - Date.now() > RENEWAL_LEAD_MS) schedule()
          else check()
        },
        Math.min(delay, LONGEST_TIMER_MS)
      )
    }
    const check = () => {
      if (!active || document.visibilityState !== 'visible') return
      void requestRenewal().finally(schedule)
    }
    const onFocus = (event: Event) => {
      if (document.visibilityState !== 'visible' || renewalInFlight.current !== undefined) return
      const previous = lastFocusEvent.current
      const now = Date.now()
      // A tab return can deliver both events after a fast renewal has already settled.
      if (previous && previous.type !== event.type && now - previous.at < RENEWAL_COOLDOWN_MS)
        return
      lastFocusEvent.current = { type: event.type, at: now }
      window.clearTimeout(focusTimer)
      const remaining = lastRenewal.current + RENEWAL_COOLDOWN_MS - Date.now()
      if (remaining > 0) focusTimer = window.setTimeout(check, remaining)
      else check()
    }
    schedule()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.clearTimeout(focusTimer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [auth.isAuthenticated, auth.credentialGeneration, requestRenewal])

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

/** Registers `onSave` with `onBeforeSignInAgain` and cleans up on unmount, so
 * a screen only has to say what to save before a re-authentication redirect,
 * never through `localStorage` (§4.7). */
export function useFormStash(onSave: () => void): void {
  const { onBeforeSignInAgain } = useSessionExpiryContext()
  useEffect(() => onBeforeSignInAgain(onSave), [onBeforeSignInAgain, onSave])
}

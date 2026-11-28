// `/auth/callback` dispatches the SDK's stored transaction. Interactive
// callbacks exchange the code and start a session; silent iframe callbacks
// notify their parent, which owns that exchange. Both paths use the installed
// identity SDK against the configured provider (or the explicit mock provider).

import { createRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { isProtectedCallbackError, readPendingRealm } from '../auth/oidc'
import { consumeReturnTo, hasReturnTo, rememberReturnTo } from '../auth/return-to'
import { KoderaStageEmblem, StageButton as Button } from '../ui/StageFrame/KoderaStageEmblem'
import { onCommunityHost } from './communityHost'
import { rootRoute } from './root-route'

export const CALLBACK_BOUNCE_KEY = 'kodera.web.auth.callbackBounceAt'
export const CALLBACK_BOUNCE_TTL_MS = 60_000

const PERMANENT_OAUTH_REFUSALS = new Set([
  'access_denied',
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'unsupported_response_type',
])

type CallbackFailure = 'none' | 'expired' | 'error'

function isTopLevelWindow(): boolean {
  try {
    return window.self === window.top
  } catch {
    return false
  }
}

function isExpiredAuthCallback(params: URLSearchParams): boolean {
  const oauthError = params.get('error')
  const description = params.get('error_description')
  if (oauthError === 'login_required') return true
  if (!description || !/\bauthentication_expired\b/i.test(description)) return false
  return !oauthError || oauthError === 'temporarily_unavailable' || oauthError === 'invalid_request'
}

function isRecoverableCallbackFailure(error: unknown, search: string): boolean {
  if (!isTopLevelWindow() || isProtectedCallbackError(error)) return false
  if (error instanceof Error && error.message === 'Invalid sign-in identity.') return false
  const params = new URLSearchParams(search)
  if (isExpiredAuthCallback(params)) return true
  const oauthError = params.get('error')
  if (oauthError && PERMANENT_OAUTH_REFUSALS.has(oauthError)) return false
  return (
    onCommunityHost() &&
    !readPendingRealm() &&
    ['code', 'state', 'session_state', 'iss'].some((k) => params.has(k))
  )
}

function consumeCallbackBounceSlot(now = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(CALLBACK_BOUNCE_KEY)
    if (raw !== null) {
      const previous = Number(raw)
      if (
        Number.isFinite(previous) &&
        now - previous < CALLBACK_BOUNCE_TTL_MS &&
        previous <= now + CALLBACK_BOUNCE_TTL_MS
      ) {
        return false
      }
    }
    const stamp = String(now)
    sessionStorage.setItem(CALLBACK_BOUNCE_KEY, stamp)
    return sessionStorage.getItem(CALLBACK_BOUNCE_KEY) === stamp
  } catch {
    return false
  }
}

function clearCallbackBounceSlot(): void {
  try {
    sessionStorage.removeItem(CALLBACK_BOUNCE_KEY)
  } catch {
    // Storage policy does not block navigation once signed in.
  }
}

function AuthCallback() {
  const { t } = useTranslation()
  const auth = useAuth()
  const router = useRouter()
  const [failed, setFailed] = useState<CallbackFailure>('none')
  const lastRealmRef = useRef<string | undefined>(undefined)

  function currentRealmHint(): string | undefined {
    const realm =
      readPendingRealm() ?? lastRealmRef.current ?? (onCommunityHost() ? 'community' : undefined)
    if (realm !== undefined) lastRealmRef.current = realm
    return realm
  }

  function navigateAuthenticatedDestination(): void {
    clearCallbackBounceSlot()
    const destination = hasReturnTo()
      ? consumeReturnTo()
      : onCommunityHost()
        ? '/community/workspace'
        : '/'
    void router.navigate({ href: destination, replace: true })
  }

  function goToLogin(realm: string | undefined): void {
    const org = onCommunityHost() || realm === 'community' ? 'community' : realm
    void router.navigate(
      org !== undefined
        ? { to: '/login', search: { org }, replace: true }
        : { to: '/login', replace: true }
    )
  }

  function restartSignIn(): void {
    if (auth.isAuthenticated) {
      navigateAuthenticatedDestination()
      return
    }
    clearCallbackBounceSlot()
    const realm = currentRealmHint()
    if (failed === 'expired' && realm !== undefined && typeof auth.signIn === 'function') {
      if (onCommunityHost() && !hasReturnTo()) rememberReturnTo('/community/workspace')
      setFailed('none')
      void auth.signIn(realm).catch(() => {
        setFailed('error')
      })
      return
    }
    goToLogin(realm)
  }

  useEffect(() => {
    let cancelled = false
    currentRealmHint()
    auth
      .handleCallback()
      .then((result) => {
        if (cancelled || result === 'silent') return
        clearCallbackBounceSlot()
        // A client-side transition, never `window.location.assign`: the
        // access token lives in memory only (docs/dev/API_CLIENT.md), and a
        // full page reload here would throw away the session this exchange
        // just obtained before a single screen ever used it.
        void router.navigate({ href: consumeReturnTo() })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (auth.isAuthenticated && !isProtectedCallbackError(error)) {
          navigateAuthenticatedDestination()
          return
        }
        if (isRecoverableCallbackFailure(error, window.location.search)) {
          const realm = currentRealmHint()
          if (consumeCallbackBounceSlot()) {
            if (realm !== undefined && typeof auth.signIn === 'function') {
              if (onCommunityHost() && !hasReturnTo()) rememberReturnTo('/community/workspace')
              void auth.signIn(realm).catch(() => {
                if (!cancelled) setFailed('expired')
              })
              return
            }
            goToLogin(realm)
            return
          }
          setFailed('expired')
          return
        }
        setFailed('error')
      })
    return () => {
      cancelled = true
    }
    // Runs once: the code in the URL is single-use, and re-running this on a
    // re-render would exchange it a second time and fail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ok = failed === 'none'
  return (
    <main className="kodera-stage kodera-stage-screen">
      <KoderaStageEmblem animated={ok} />
      <p
        role="status"
        aria-live="polite"
        className={ok ? 'stage-status stage-status-on' : 'stage-status-err'}
      >
        {ok
          ? t('console.login.handoff.a11y-redirecting')
          : failed === 'expired'
            ? t('console.shell.session.body-unrecognized')
            : t('console.shell._.error-load-failed')}
      </p>
      {ok ? null : (
        <Button variant="secondary" onClick={restartSignIn}>
          {t('console.shell.session.action-sign-in-again')}
        </Button>
      )}
    </main>
  )
}

export const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallback,
})

// `/espace/callback` completes Espace's Synapse SSO redirect (`src/auth/matrix.ts`,
// messaging-pilot design §2.4, E7). Sitting on `rootRoute` outside `/$org` (`orgRoute`)
// keeps `org-route.tsx`'s `rememberReturnTo(location.href)` from ever copying the
// single-use `loginToken` into `sessionStorage`.

import { createRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import {
  MATRIX_CALLBACK_PATH,
  MatrixSignInFailed,
  completeMatrixSignIn,
  type MatrixSession,
  type MatrixSignInProblem,
} from '../auth/matrix'
import { authAdapter } from '../auth/oidc'
import { rootRoute } from './root-route'

function safeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    return '/'
  }
  try {
    const parsed = new URL(returnTo, window.location.origin)
    if (parsed.origin !== window.location.origin) return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

function EspaceCallback() {
  const { t } = useTranslation()
  const auth = useAuth()
  const router = useRouter()
  const [failed, setFailed] = useState<'none' | MatrixSignInProblem | 'error'>('none')
  const exchangeRef = useRef<Promise<{ session: MatrixSession; returnTo: string }> | null>(null)

  useEffect(() => {
    let cancelled = false
    if (exchangeRef.current === null) {
      exchangeRef.current = (async () => {
        const href = window.location.href
        const immediateSub =
          auth.user?.identity?.subject ?? authAdapter.getUser()?.identity?.subject
        if (immediateSub !== undefined) {
          return completeMatrixSignIn(href, immediateSub)
        }
        // When Synapse returns via a full-page redirect and the Console session has not been
        // restored into memory yet, strip the single-use `loginToken` and `state` from the
        // address bar immediately before awaiting session restoration.
        const clean = new URL(href)
        clean.searchParams.delete('loginToken')
        clean.searchParams.delete('state')
        window.history.replaceState(null, '', clean.href)
        await authAdapter.restoreSession()
        const restoredSub = authAdapter.getUser()?.identity?.subject
        if (restoredSub === undefined) {
          return completeMatrixSignIn(clean.href, '')
        }
        return completeMatrixSignIn(href, restoredSub)
      })()
    }
    exchangeRef.current
      .then(({ returnTo }) => {
        if (cancelled) return
        // `replace`: « back » from the workspace must not land on the spent callback.
        void router.navigate({ href: safeReturnTo(returnTo), replace: true })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFailed(err instanceof MatrixSignInFailed ? err.problem : 'error')
      })
    return () => {
      cancelled = true
    }
    // Runs once per callback mount: `loginToken` and `kodera.web.espace.signin` are
    // single-use, and deduplicating via `exchangeRef` keeps StrictMode's double effect invocation
    // from consuming the pending state twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <p
        role="status"
        aria-live="polite"
        data-problem={failed === 'none' ? undefined : failed}
        className="text-md text-c-ink-3"
      >
        {failed === 'none'
          ? t('console.login.handoff.a11y-redirecting')
          : failed === 'other-person'
            ? t('console.shell.session.body-restore-failed')
            : t('console.shell._.error-load-failed')}
      </p>
    </main>
  )
}

export const espaceCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MATRIX_CALLBACK_PATH,
  component: EspaceCallback,
})

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
import { KoderaStageEmblem, StageSecondaryLink } from '../ui/StageFrame/KoderaStageEmblem'
import { rootRoute } from './root-route'

function safeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    return '/'
  }
  try {
    const baseOrigin = location.origin === 'null' ? 'https://kodera.local' : location.origin
    const parsed = new URL(returnTo, baseOrigin)
    return parsed.origin === baseOrigin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/'
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
        const href = location.href
        const immediateSub =
          auth.user?.identity?.subject ?? authAdapter.getUser()?.identity?.subject
        if (immediateSub !== undefined) return completeMatrixSignIn(href, immediateSub)
        const clean = new URL(href)
        clean.searchParams.delete('loginToken')
        clean.searchParams.delete('state')
        history.replaceState(null, '', clean.href)
        await authAdapter.restoreSession()
        const restoredSub = authAdapter.getUser()?.identity?.subject
        return completeMatrixSignIn(
          restoredSub === undefined ? clean.href : href,
          restoredSub ?? ''
        )
      })()
    }
    exchangeRef.current
      .then(({ returnTo }) => {
        if (cancelled) return
        void router.navigate({ href: safeReturnTo(returnTo), replace: true })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFailed(err instanceof MatrixSignInFailed ? err.problem : 'error')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ok = failed === 'none'
  return (
    <main className="kodera-stage kodera-stage-screen">
      <KoderaStageEmblem animated={ok} />
      <p
        role="status"
        aria-live="polite"
        data-problem={ok ? undefined : failed}
        className={ok ? 'stage-status stage-status-on' : 'stage-status-err'}
      >
        {ok
          ? t('console.login.handoff.a11y-redirecting')
          : failed === 'rate-limited'
            ? t('console.shell.session.matrix-rate-limited')
            : failed === 'other-person'
              ? t('console.shell.session.body-restore-failed')
              : t('console.shell._.error-load-failed')}
      </p>
      {failed === 'rate-limited' ? (
        <StageSecondaryLink href="/">
          {t('console.shell.session.action-sign-in-again')}
        </StageSecondaryLink>
      ) : null}
    </main>
  )
}

export const espaceCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MATRIX_CALLBACK_PATH,
  component: EspaceCallback,
})

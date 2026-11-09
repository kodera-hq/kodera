// `/auth/callback` dispatches the SDK's stored transaction. Interactive
// callbacks exchange the code and start a session; silent iframe callbacks
// notify their parent, which owns that exchange. Both paths use the installed
// identity SDK against the configured provider (or the explicit mock provider).

import { createRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { consumeReturnTo } from '../auth/return-to'
import { rootRoute } from './root-route'

function AuthCallback() {
  const { t } = useTranslation()
  const auth = useAuth()
  const router = useRouter()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    auth
      .handleCallback()
      .then((result) => {
        if (cancelled || result === 'silent') return
        // A client-side transition, never `window.location.assign`: the
        // access token lives in memory only (docs/dev/API_CLIENT.md), and a
        // full page reload here would throw away the session this exchange
        // just obtained before a single screen ever used it.
        void router.navigate({ href: consumeReturnTo() })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
    // Runs once: the code in the URL is single-use, and re-running this on a
    // re-render would exchange it a second time and fail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <p role="status" aria-live="polite" className="text-md text-c-ink-3">
        {failed
          ? t('console.shell._.error-load-failed')
          : t('console.login.handoff.a11y-redirecting')}
      </p>
    </main>
  )
}

export const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallback,
})

// `login-handoff` (docs/specs/00-shell-and-login.md §4.3): a short
// interstitial shown only while the browser is being sent to
// `id.kodera.io`, so a slow redirect is never a blank page. No route of
// its own — §3's entry-point table names no URL for it, and it only ever
// appears for the seconds between a resolved realm and the browser actually
// leaving, so `LoginScreen` renders it as a view rather than a navigation.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authAdapter } from '../../auth/oidc'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { Spinner } from '../../ui/Spinner/Spinner'

export interface HandoffProps {
  realm: string
  organisationName: string
}

// State-matrix "Redirect blocked → manual Continuer + 'Autorisez les
// redirections'" (§5): a real redirect leaves the page well inside this
// delay, so the manual control only ever appears when it did not.
const MANUAL_CONTINUE_DELAY_MS = 3000

export function Handoff({ realm, organisationName }: HandoffProps) {
  const { t } = useTranslation()
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    void authAdapter.signIn(realm)
    const timer = window.setTimeout(() => setBlocked(true), MANUAL_CONTINUE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [realm])

  return (
    <main className="flex min-h-screen items-center justify-center p-6 narrow:p-4">
      <Card className="w-full max-w-[420px] text-center">
        <CardBody className="flex flex-col items-center gap-4">
          <Spinner size="lg" />
          {/* One live region, polite (§10): the redirect message and, once it
              is stale, the blocked-redirect explanation share it rather than
              competing for attention. */}
          <p role="status" aria-live="polite" className="text-md text-c-ink">
            {t('console.login.handoff.title', { organisation: organisationName })}
          </p>
          {blocked ? (
            <>
              <p className="text-sm text-c-ink-3">{t('console.login.handoff.error-blocked')}</p>
              <Button onClick={() => void authAdapter.signIn(realm)}>
                {t('console.login.handoff.action-continue')}
              </Button>
            </>
          ) : null}
        </CardBody>
      </Card>
    </main>
  )
}

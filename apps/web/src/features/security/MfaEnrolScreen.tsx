import { lazy, Suspense, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'

export interface MfaEnrolScreenProps {
  accountEmail: string
  onEnrolled: () => void
}

// Literal env comparisons let Vite remove the import and its entire simulated
// verifier/recovery-code graph from every non-mock build. A runtime helper
// would retain that code in production even when the screen never opens.
const Simulation =
  import.meta.env.VITE_AUTH_MODE === 'mock' && import.meta.env.VITE_ENABLE_MSW === '1'
    ? lazy(() =>
        import('./mock/MfaEnrolSimulation').then((module) => ({
          default: module.MfaEnrolSimulation,
        }))
      )
    : undefined

export function MfaEnrolScreen(props: MfaEnrolScreenProps) {
  const { t } = useTranslation()
  if (Simulation !== undefined) {
    return (
      <Suspense fallback={<p role="status">{t('console.login.mfa.status-loading-simulation')}</p>}>
        <Simulation {...props} />
      </Suspense>
    )
  }
  return <EnrollmentUnavailable />
}

function EnrollmentUnavailable() {
  const { t } = useTranslation()
  const auth = useAuth()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex w-full flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold text-c-ink outline-hidden">
          {t('console.login.mfa.title-unavailable')}
        </h1>
        <InlineAlert kind="warning">{t('console.login.mfa.body-unavailable')}</InlineAlert>
        <Button className="self-start" onClick={() => void auth.signOut().catch(() => {})}>
          {t('console.shell.account.action-sign-out')}
        </Button>
      </div>
    </div>
  )
}

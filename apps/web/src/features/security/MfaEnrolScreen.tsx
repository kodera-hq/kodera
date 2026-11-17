import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { authAdapter } from '../../auth/oidc'
import { rememberReturnTo } from '../../auth/return-to'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { communityCopy } from '../login/communityMessages'

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
  if (
    import.meta.env.VITE_AUTH_MODE === 'oidc' &&
    typeof window !== 'undefined' &&
    window.location.pathname === '/community/security/mfa'
  ) {
    return <CommunityMfaEnrol accountEmail={props.accountEmail} />
  }
  return <EnrollmentUnavailable />
}

function CommunityMfaEnrol({ accountEmail }: { accountEmail: string }) {
  const { i18n } = useTranslation()
  const auth = useAuth()
  const copy = communityCopy(i18n.resolvedLanguage)
  const heading = useRef<HTMLHeadingElement>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  async function start(options: { kcAction?: 'CONFIGURE_TOTP'; prompt: 'login' }) {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      rememberReturnTo('/community/workspace')
      await authAdapter.signIn('community', options)
    } catch {
      setPending(false)
      setFailed(true)
    }
  }

  return (
    <div className="flex flex-col items-center py-6">
      <Card className="w-full max-w-shell-document-min-width">
        <CardBody className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-2">
            <h1
              ref={heading}
              tabIndex={-1}
              className="text-xl font-semibold text-c-ink outline-hidden"
            >
              {copy.mfaTitle}
            </h1>
            {accountEmail ? <p className="font-mono text-xs text-c-ink-3">{accountEmail}</p> : null}
            <p className="text-sm text-c-ink-2">{copy.mfaBody}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={pending}
              onClick={() => void start({ kcAction: 'CONFIGURE_TOTP', prompt: 'login' })}
            >
              {copy.mfaConfigure}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void start({ prompt: 'login' })}
            >
              {copy.mfaVerify}
            </Button>
          </div>
          {pending ? (
            <p role="status" className="text-sm text-c-ink-2">
              {copy.pending}
            </p>
          ) : null}
          {failed ? <InlineAlert kind="error">{copy.error}</InlineAlert> : null}
          <Button
            className="self-start"
            variant="tertiary"
            disabled={pending}
            onClick={() => void auth.signOut().catch(() => {})}
          >
            {copy.mfaSignOut}
          </Button>
        </CardBody>
      </Card>
    </div>
  )
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

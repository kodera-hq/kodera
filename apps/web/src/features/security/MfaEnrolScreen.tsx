import { useRouter, useRouterState } from '@tanstack/react-router'
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
  org?: string | undefined
  sharedRealm?: boolean | undefined
  memberRole?: string | undefined
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
  const router = useRouter({ warn: false })
  return router ? (
    <RoutedMfaEnrolScreen {...props} />
  ) : (
    <MfaEnrolAtPath {...props} pathname={window.location.pathname} />
  )
}

function RoutedMfaEnrolScreen(props: MfaEnrolScreenProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return <MfaEnrolAtPath {...props} pathname={pathname} />
}

function MfaEnrolAtPath(props: MfaEnrolScreenProps & { pathname: string }) {
  const { t } = useTranslation()
  const auth = useAuth()
  if (Simulation !== undefined) {
    return (
      <Suspense fallback={<p role="status">{t('console.login.mfa.status-loading-simulation')}</p>}>
        <Simulation {...props} />
      </Suspense>
    )
  }
  const activeRealm = auth.user?.realm
  let pathname = props.pathname
  try {
    pathname = decodeURIComponent(pathname).replace(/\/+$/, '')
  } catch {
    // Malformed path encoding cannot grant access to enrollment.
    return <EnrollmentUnavailable />
  }
  const targetOrg = props.org ?? (pathname === '/community/security/mfa' ? 'community' : undefined)
  if (
    import.meta.env.VITE_AUTH_MODE === 'oidc' &&
    targetOrg !== undefined &&
    (activeRealm === 'community' || activeRealm === 'kodera-staff') &&
    (targetOrg === 'community' ||
      (props.sharedRealm === true &&
        pathname === `/${targetOrg}/security/mfa` &&
        activeRealm === 'community'))
  ) {
    return (
      <CommunityMfaEnrol
        accountEmail={props.accountEmail}
        realm={activeRealm}
        memberRole={props.memberRole}
        targetOrg={targetOrg}
      />
    )
  }
  return <EnrollmentUnavailable />
}

function CommunityMfaEnrol({
  accountEmail,
  realm,
  memberRole,
  targetOrg,
}: {
  accountEmail: string
  realm: 'community' | 'kodera-staff'
  memberRole?: string | undefined
  targetOrg: string
}) {
  const { i18n } = useTranslation()
  const auth = useAuth()
  const copy = communityCopy(i18n.resolvedLanguage)
  const isEnglish = i18n.resolvedLanguage?.startsWith('en') === true
  const isVoluntaryMember = memberRole === 'org_member'
  const headingText = isVoluntaryMember
    ? isEnglish
      ? 'Protect your account (2FA)'
      : 'Protéger votre compte (2FA)'
    : copy.mfaTitle
  const bodyText = isVoluntaryMember
    ? isEnglish
      ? 'Strengthen the security of your Kodera account with an authenticator app (TOTP) or a hardware security key.'
      : 'Renforcez la sécurité de votre compte Kodera avec une application d’authentification (TOTP) ou une clé de sécurité matérielle.'
    : copy.mfaBody
  const heading = useRef<HTMLHeadingElement>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const hasSecondFactor =
    auth.user?.identity?.amr?.some((method) => method === 'otp' || method === 'hwk') === true
  const showConfigureTotp = realm === 'community' && !hasSecondFactor

  useEffect(() => {
    heading.current?.focus()
  }, [])

  async function start(options: { kcAction?: 'CONFIGURE_TOTP'; prompt: 'login' }) {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      rememberReturnTo(
        targetOrg === 'community'
          ? '/community/workspace'
          : `/${encodeURIComponent(targetOrg)}/workspace`
      )
      await authAdapter.signIn(realm, options)
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
              {headingText}
            </h1>
            {accountEmail ? <p className="font-mono text-xs text-c-ink-3">{accountEmail}</p> : null}
            <p className="text-sm text-c-ink-2">{bodyText}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {showConfigureTotp ? (
              <Button
                disabled={pending}
                onClick={() => void start({ kcAction: 'CONFIGURE_TOTP', prompt: 'login' })}
              >
                {copy.mfaConfigure}
              </Button>
            ) : null}
            <Button
              variant={showConfigureTotp ? 'secondary' : 'primary'}
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

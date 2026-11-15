import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { Button } from '../../ui/Button/Button'
import { Card } from '../../ui/Card/Card'
import { EmailField } from '../../ui/EmailField/EmailField'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import type { PassportVerifiedSession } from './passportClient'
import {
  generatePassportPkcePair,
  normalizePassportEmailInput,
  requestPassportMagicLink,
  verifyPassportMagicLink,
} from './passportClient'

export interface PassportMagicLinkVerificationInput {
  readonly token: string
  readonly codeVerifier: string
  readonly deviceVerifier?: string | null
}

export interface PassportMagicLinkRequestedEvent {
  readonly email: string
  readonly codeVerifier: string
  readonly expiresInSeconds: number
}

export interface PassportMagicLinkFormProps {
  readonly initialEmail?: string
  readonly deviceChallenge?: string | null
  readonly verification?: PassportMagicLinkVerificationInput | null
  readonly onRequested?: (event: PassportMagicLinkRequestedEvent) => void
  readonly onVerified?: (session: PassportVerifiedSession) => void
}

type FormAlert =
  | { readonly kind: 'success'; readonly messageKey: 'console.login.passport.sent' }
  | {
      readonly kind: 'error'
      readonly messageKey:
        | 'console.login.passport.problem-rate-limited'
        | 'console.login.passport.problem-expired'
        | 'console.login.passport.problem-network'
    }

export function PassportMagicLinkForm({
  initialEmail = '',
  deviceChallenge = null,
  verification = null,
  onRequested,
  onVerified,
}: PassportMagicLinkFormProps) {
  const { t } = useTranslation()
  const [email, setEmail] = useState(initialEmail)
  const [emailError, setEmailError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [settledTokenKey, setSettledTokenKey] = useState<string | null>(null)
  const [alert, setAlert] = useState<FormAlert | null>(null)
  const consumedTokenRef = useRef<string | null>(null)
  const onVerifiedRef = useRef(onVerified)
  const mountedRef = useRef(true)

  const verificationKey = verification ? `${verification.token}:${verification.codeVerifier}` : null
  const verifying = verificationKey !== null && settledTokenKey !== verificationKey

  useEffect(() => {
    onVerifiedRef.current = onVerified
  }, [onVerified])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!verification || verificationKey === null) {
      return
    }
    if (consumedTokenRef.current === verificationKey) {
      return
    }
    consumedTokenRef.current = verificationKey

    void verifyPassportMagicLink({
      token: verification.token,
      codeVerifier: verification.codeVerifier,
      deviceVerifier: verification.deviceVerifier ?? null,
    })
      .then((session) => {
        if (!mountedRef.current) return
        setSettledTokenKey(verificationKey)
        setAlert(null)
        onVerifiedRef.current?.(session)
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return
        setSettledTokenKey(verificationKey)
        if (error instanceof ApiProblem && (error.status === 401 || error.status === 422)) {
          setAlert({ kind: 'error', messageKey: 'console.login.passport.problem-expired' })
        } else {
          setAlert({ kind: 'error', messageKey: 'console.login.passport.problem-network' })
        }
      })
  }, [verification, verificationKey])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || verifying) return

    const normalized = normalizePassportEmailInput(email)
    if (!normalized) {
      setEmailError(true)
      setAlert(null)
      return
    }

    setEmailError(false)
    setSubmitting(true)
    setAlert(null)

    try {
      const pkce = await generatePassportPkcePair()
      const accepted = await requestPassportMagicLink({
        email: normalized,
        codeChallenge: pkce.codeChallenge,
        deviceChallenge,
      })
      onRequested?.({
        email: normalized,
        codeVerifier: pkce.codeVerifier,
        expiresInSeconds: accepted.expires_in_seconds,
      })
      setAlert({ kind: 'success', messageKey: 'console.login.passport.sent' })
    } catch (error: unknown) {
      if (error instanceof ApiProblem && error.status === 429) {
        setAlert({ kind: 'error', messageKey: 'console.login.passport.problem-rate-limited' })
      } else if (error instanceof ApiProblem && error.status === 422) {
        setEmailError(true)
      } else {
        setAlert({ kind: 'error', messageKey: 'console.login.passport.problem-network' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="flex w-full max-w-[420px] flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold text-c-ink">{t('console.login.passport.title')}</h2>
        <p className="mt-1 text-sm text-c-ink-3">{t('console.login.passport.subtitle')}</p>
      </div>

      {verifying ? (
        <InlineAlert kind="info">{t('console.login.passport.verifying')}</InlineAlert>
      ) : null}

      {alert ? <InlineAlert kind={alert.kind}>{t(alert.messageKey)}</InlineAlert> : null}

      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        <EmailField
          label={t('console.login.passport.field-email')}
          autoComplete="username"
          value={email}
          disabled={submitting || verifying}
          onChange={(event) => {
            setEmail(event.target.value)
            if (emailError) setEmailError(false)
          }}
          {...(emailError ? { error: t('console.login.passport.problem-email') } : {})}
        />

        <Button type="submit" variant="primary" disabled={submitting || verifying}>
          {submitting
            ? t('console.login.passport.action-sending')
            : t('console.login.passport.action-send')}
        </Button>
      </form>
    </Card>
  )
}

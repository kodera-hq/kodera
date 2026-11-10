// Demonstration only: imported exclusively by the explicit mock/MSW build.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from '@/validation-policy'
import {
  trackEnrolmentAbandoned,
  trackEnrolmentCompleted,
  trackEnrolmentStarted,
} from '../analytics'
import { Button } from '../../../ui/Button/Button'
import { Card, CardBody } from '../../../ui/Card/Card'
import { Form } from '../../../ui/Form/Form'
import { FormField } from '../../../ui/Form/FormField'
import { InlineAlert } from '../../../ui/InlineAlert/InlineAlert'
import { QrPanel } from '../../../ui/QrPanel/QrPanel'
import { Stepper } from '../../../ui/Stepper/Stepper'
import { markMfaEnrolledLocally } from '../mfaState'
import {
  formatSecret,
  generateRecoveryCodes,
  isTotpFormatValid,
  LOCKOUT_S,
  MAX_ATTEMPTS,
  normalizeTotpCode,
  otpauthUri,
  verifyTotpCode,
} from './totp'

// Fixed rather than random: a QR that changes on every render would make the
// "secret can be copied" acceptance test (test 5) assert on a moving target,
// and there is no server this guide round-trips the secret against anyway.
const MOCK_SECRET = 'JBSWY3DPEHPK3PXP'

type Method = 'choose' | 'totp'
type TotpStep = 'scan' | 'recovery'

interface CodeFormValues {
  code: string
}

import type { MfaEnrolScreenProps } from '../MfaEnrolScreen'

export function MfaEnrolSimulation({ accountEmail, onEnrolled }: MfaEnrolScreenProps) {
  const { t } = useTranslation()
  const [method, setMethod] = useState<Method>('choose')
  const [passkeyError, setPasskeyError] = useState<string | undefined>(undefined)
  const [totpStep, setTotpStep] = useState<TotpStep>('scan')
  const [codeError, setCodeError] = useState<string | undefined>(undefined)
  const [attempts, setAttempts] = useState(0)
  const [lockedUntilS, setLockedUntilS] = useState(0)
  const [secretCopyStatus, setSecretCopyStatus] = useState<'idle' | 'copied'>('idle')
  const [downloaded, setDownloaded] = useState(false)
  const [recoveryCodes] = useState(() => generateRecoveryCodes())
  const headingRef = useRef<HTMLHeadingElement>(null)
  // §10 route-change focus rule, applied to the guide's own internal steps:
  // each one is a screen in its own right while it is on display.
  useEffect(() => {
    headingRef.current?.focus()
  }, [method, totpStep])

  useEffect(() => {
    if (lockedUntilS <= 0) return
    const timer = window.setInterval(() => setLockedUntilS((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [lockedUntilS])

  function tryPasskey() {
    trackEnrolmentStarted('passkey')
    setPasskeyError(t('console.login.mfa.error-passkey-unsupported'))
    trackEnrolmentAbandoned('passkey', 'unsupported')
  }

  function startTotp() {
    trackEnrolmentStarted('totp')
    setMethod('totp')
  }

  const codeSchema = z.object({
    code: z
      .string()
      .transform(normalizeTotpCode)
      .refine(isTotpFormatValid, { message: t('console.login.mfa.error-code-format') }),
  })

  async function onSubmitCode(values: CodeFormValues) {
    if (lockedUntilS > 0) return
    if (verifyTotpCode(values.code)) {
      setCodeError(undefined)
      trackEnrolmentCompleted('totp', attempts + 1)
      setTotpStep('recovery')
      return
    }
    const nextAttempts = attempts + 1
    setAttempts(nextAttempts)
    if (nextAttempts >= MAX_ATTEMPTS) {
      setLockedUntilS(LOCKOUT_S)
      setCodeError(t('console.login.mfa.error-locked', { seconds: LOCKOUT_S }))
    } else {
      setCodeError(t('console.login.mfa.error-code-invalid'))
    }
  }

  function downloadRecoveryCodes() {
    const blob = new Blob([recoveryCodes.join('\n') + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'kodera-codes-de-secours.txt'
    link.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
  }

  function finish() {
    markMfaEnrolledLocally()
    onEnrolled()
  }

  return (
    <div data-mfa-enrolment-simulation="true" className="flex flex-col items-center gap-6">
      <div className="w-full max-w-[520px]">
        <InlineAlert kind="warning">{t('console.login.mfa.warning-simulation')}</InlineAlert>
        {method === 'choose' ? (
          <>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-c-ink outline-hidden"
            >
              {t('console.login.mfa.title')}
            </h1>
            <p className="mt-1 text-md text-c-ink-3">{t('console.login.mfa.subtitle')}</p>

            <div className="mt-6 flex flex-col gap-4">
              <Card>
                <CardBody className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-md font-semibold text-c-ink">
                      {t('console.login.mfa.title-passkey')}
                    </h2>
                    <p className="mt-1 text-sm text-c-ink-3">
                      {t('console.login.mfa.subtitle-passkey')}
                    </p>
                  </div>
                  {passkeyError === undefined ? null : (
                    <InlineAlert kind="error">{passkeyError}</InlineAlert>
                  )}
                  <Button onClick={tryPasskey} className="self-start">
                    {t('console.login.mfa.action-passkey')}
                  </Button>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-md font-semibold text-c-ink">
                      {t('console.login.mfa.title-totp')}
                    </h2>
                    <p className="mt-1 text-sm text-c-ink-3">
                      {t('console.login.mfa.subtitle-totp')}
                    </p>
                  </div>
                  <Button variant="secondary" onClick={startTotp} className="self-start">
                    {t('console.login.mfa.action-totp')}
                  </Button>
                </CardBody>
              </Card>
            </div>

            <p className="mt-4 text-sm text-c-ink-3">{t('console.login.mfa.hint-no-sms')}</p>
          </>
        ) : (
          <>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-c-ink outline-hidden"
            >
              {t('console.login.mfa.title')}
            </h1>

            <div className="mt-4">
              <Stepper
                steps={[
                  {
                    label: t('console.login.mfa.title-totp-step1'),
                    status: totpStep === 'scan' ? 'current' : 'done',
                  },
                  {
                    label: t('console.login.mfa.title-totp-step2'),
                    status: totpStep === 'scan' ? 'upcoming' : 'done',
                  },
                  {
                    label: t('console.login.mfa.title-totp-step3'),
                    status: totpStep === 'recovery' ? 'current' : 'upcoming',
                  },
                ]}
              />
            </div>

            {totpStep === 'scan' ? (
              <Card className="mt-4">
                <CardBody className="flex flex-col gap-4">
                  <h2 className="text-md font-semibold text-c-ink">
                    {t('console.login.mfa.title-totp-step1')}
                  </h2>
                  <QrPanel
                    value={otpauthUri(MOCK_SECRET, accountEmail, 'Kodera')}
                    alt={t('console.login.mfa.title-totp-step1')}
                    failureMessage={t('console.common.error-unavailable')}
                    code={{
                      label: t('console.login.mfa.hint-totp-secret'),
                      value: formatSecret(MOCK_SECRET),
                      status: secretCopyStatus,
                      copyLabel: t('console.common.action-copy'),
                      copiedLabel: t('console.common.toast-copied'),
                      onCopy: () => {
                        void navigator.clipboard.writeText(MOCK_SECRET)
                        setSecretCopyStatus('copied')
                        window.setTimeout(() => setSecretCopyStatus('idle'), 1500)
                      },
                    }}
                  />

                  <h2 className="text-md font-semibold text-c-ink">
                    {t('console.login.mfa.title-totp-step2')}
                  </h2>
                  <Form<CodeFormValues>
                    schema={codeSchema}
                    defaultValues={{ code: '' }}
                    mode="onSubmit"
                    onSubmit={onSubmitCode}
                  >
                    <FormField
                      name="code"
                      label={t('console.login.mfa.label-code')}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      disabled={lockedUntilS > 0}
                    />
                    {codeError === undefined ? null : (
                      <InlineAlert kind="error">{codeError}</InlineAlert>
                    )}
                    <Button type="submit" disabled={lockedUntilS > 0} className="mt-2">
                      {t('console.login.mfa.action-finish')}
                    </Button>
                  </Form>
                </CardBody>
              </Card>
            ) : (
              <Card className="mt-4">
                <CardBody className="flex flex-col gap-4">
                  <h2 className="text-md font-semibold text-c-ink">
                    {t('console.login.mfa.title-totp-step3')}
                  </h2>
                  <p className="text-sm text-c-ink-3">{t('console.login.mfa.subtitle-recovery')}</p>
                  <ul className="grid grid-cols-2 gap-2 rounded-md bg-c-muted p-3 font-mono text-sm text-c-ink">
                    {recoveryCodes.map((code) => (
                      <li key={code}>{code}</li>
                    ))}
                  </ul>
                  {downloaded ? null : (
                    <InlineAlert kind="warning">
                      {t('console.login.mfa.warning-recovery-not-saved')}
                    </InlineAlert>
                  )}
                  <div className="flex gap-3">
                    <Button variant="secondary" onClick={downloadRecoveryCodes}>
                      {t('console.login.mfa.action-download-recovery')}
                    </Button>
                    <Button variant="secondary" onClick={() => window.print()}>
                      {t('console.login.mfa.action-print-recovery')}
                    </Button>
                  </div>
                  <p role="status" aria-live="polite" className="sr-only">
                    {downloaded ? t('console.login.mfa.a11y-enrolled') : ''}
                  </p>
                  <Button onClick={finish} className="self-start">
                    {t('console.login.mfa.action-finish')}
                  </Button>
                </CardBody>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}

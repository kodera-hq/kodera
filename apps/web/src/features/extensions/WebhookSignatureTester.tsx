import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import {
  signTestWebhook,
  verifyTestWebhook,
  WebhookTestFailure,
  type WebhookTestError,
} from './webhookTester'
import { webhookTesterCopy } from './webhookTesterMessages'

const INPUT =
  'w-full rounded-md border border-c-border-input bg-c-surface px-3 py-2 font-mono text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden'

export function WebhookSignatureTester({ extensionId }: { extensionId: string }) {
  const { i18n } = useTranslation()
  const copy = webhookTesterCopy(i18n.resolvedLanguage)
  const id = useId()
  const sample = JSON.stringify(
    { event: 'test.webhook', extension_id: extensionId, message: 'Hello, Kodera!' },
    null,
    2
  )
  const [secret, setSecret] = useState('')
  const [body, setBody] = useState(sample)
  const [timestamp, setTimestamp] = useState('')
  const [signature, setSignature] = useState('')
  const [result, setResult] = useState<'signed' | 'verified' | null>(null)
  const [error, setError] = useState<WebhookTestError | null>(null)
  const [busy, setBusy] = useState(false)

  function edited() {
    setResult(null)
    setError(null)
  }

  async function run(action: 'sign' | 'verify') {
    edited()
    setBusy(true)
    try {
      if (action === 'sign') {
        const now = String(Math.floor(Date.now() / 1000))
        const signed = await signTestWebhook(secret, now, body)
        setTimestamp(now)
        setSignature(signed)
        setResult('signed')
      } else {
        await verifyTestWebhook(secret, timestamp, body, signature)
        setResult('verified')
      }
    } catch (failure) {
      setError(failure instanceof WebhookTestFailure ? failure.code : 'UNAVAILABLE')
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset
      disabled={busy}
      className="flex min-w-0 flex-col gap-3 border-t border-c-border-soft pt-4"
    >
      <legend className="text-sm font-semibold text-c-ink">{copy.title}</legend>
      <p className="text-sm text-c-ink-2">{copy.hint}</p>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-secret`} className="text-xs font-medium text-c-ink-2">
          {copy.secret}
        </label>
        <input
          id={`${id}-secret`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value)
            edited()
          }}
          className={INPUT}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            edited()
            try {
              const bytes = crypto.getRandomValues(new Uint8Array(32))
              setSecret(
                `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
              )
            } catch {
              setError('UNAVAILABLE')
            }
          }}
        >
          {copy.generate}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-body`} className="text-xs font-medium text-c-ink-2">
          {copy.payload}
        </label>
        <textarea
          id={`${id}-body`}
          rows={5}
          spellCheck={false}
          maxLength={65536}
          value={body}
          onChange={(event) => {
            setBody(event.target.value)
            edited()
          }}
          className={INPUT}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-timestamp`} className="text-xs font-medium text-c-ink-2">
          {copy.timestamp}
        </label>
        <input
          id={`${id}-timestamp`}
          inputMode="numeric"
          value={timestamp}
          onChange={(event) => {
            setTimestamp(event.target.value)
            edited()
          }}
          className={INPUT}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-signature`} className="text-xs font-medium text-c-ink-2">
          {copy.signature}
        </label>
        <input
          id={`${id}-signature`}
          autoComplete="off"
          spellCheck={false}
          value={signature}
          onChange={(event) => {
            setSignature(event.target.value)
            edited()
          }}
          className={INPUT}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            void run('sign')
          }}
        >
          {copy.sign}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void run('verify')
          }}
        >
          {copy.verify}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          onClick={() => {
            setSecret('')
            setSignature('')
            setTimestamp('')
            setBody(sample)
            edited()
          }}
        >
          {copy.clear}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-c-bad-ink">
          {copy.errors[error]}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-sm text-c-ok-ink">
          {copy[result]}
        </p>
      ) : null}
      <p className="text-xs text-c-ink-3">{copy.protocol}</p>
    </fieldset>
  )
}

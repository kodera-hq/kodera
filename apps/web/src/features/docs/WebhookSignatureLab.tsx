import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { developerDocsCopy } from './developerDocsMessages'
import {
  signExampleWebhook,
  verifyExampleWebhook,
  WebhookExampleError,
  type WebhookExample,
} from './webhookSimulator'
export function WebhookSignatureLab() {
  const { i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const id = useId()
  const [input, setInput] = useState<WebhookExample>(() => ({
    scheme: 'kodera',
    secret: 'local-example-secret-only',
    payload: '{"type":"asset.ready","assetId":"demo-1"}',
    timestamp: String(Math.floor(Date.now() / 1000)),
  }))
  const [signature, setSignature] = useState('')
  const [status, setStatus] = useState<'valid' | 'invalid' | WebhookExampleError['code'] | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  useEffect(
    () => () => {
      epoch.current++
    },
    []
  )
  function edit(change: Partial<WebhookExample>, header?: string) {
    epoch.current++
    setInput((previous) => ({ ...previous, ...change }))
    if (header !== undefined) setSignature(header)
    setStatus(null)
    setBusy(false)
  }
  async function run(sign: boolean) {
    const current = ++epoch.current
    setBusy(true)
    setStatus(null)
    try {
      if (sign) {
        const header = await signExampleWebhook(input)
        if (current === epoch.current) setSignature(header)
      } else {
        const verified = await verifyExampleWebhook({ ...input, signature })
        if (current === epoch.current) setStatus(verified ? 'valid' : 'invalid')
      }
    } catch (error) {
      if (current === epoch.current)
        setStatus(error instanceof WebhookExampleError ? error.code : 'CRYPTO_UNAVAILABLE')
    } finally {
      if (current === epoch.current) setBusy(false)
    }
  }
  const field =
    'w-full rounded-md border border-c-border-input bg-c-surface p-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden'
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-6 flex flex-col gap-4 rounded-lg border border-c-border bg-c-sunken p-4"
    >
      <h3 id={`${id}-title`} className="text-lg font-semibold">
        {copy.lab}
      </h3>
      <p className="text-sm text-c-ink-2">{copy.labNote}</p>
      <label className="flex flex-col gap-2 text-sm">
        {copy.scheme}
        <select
          value={input.scheme}
          onChange={(event) =>
            edit({ scheme: event.target.value === 'github' ? 'github' : 'kodera' })
          }
          className={field}
        >
          <option value="kodera">{copy.kodera}</option>
          <option value="github">{copy.github}</option>
        </select>
      </label>
      <label className="flex flex-col gap-2 text-sm">
        {copy.secret}
        <input
          value={input.secret}
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => edit({ secret: event.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        {copy.payload}
        <textarea
          rows={4}
          value={input.payload}
          maxLength={65536}
          spellCheck={false}
          onChange={(event) => edit({ payload: event.target.value })}
          className={`${field} font-mono`}
        />
      </label>
      {input.scheme === 'kodera' ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
            {copy.timestamp}
            <input
              value={input.timestamp}
              maxLength={16}
              inputMode="numeric"
              onChange={(event) => edit({ timestamp: event.target.value })}
              className={`${field} font-mono`}
            />
          </label>
          <Button onClick={() => edit({ timestamp: String(Math.floor(Date.now() / 1000)) })}>
            {copy.now}
          </Button>
        </div>
      ) : null}
      <p className="overflow-x-auto font-mono text-xs text-c-ink-2">
        {input.scheme === 'kodera'
          ? 'v1=HMAC-SHA256(secret, timestamp + "." + rawBody)'
          : 'sha256=HMAC-SHA256(secret, rawBody)'}
      </p>
      <label className="flex flex-col gap-2 text-sm">
        {copy.signature}
        <input
          value={signature}
          maxLength={80}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit({}, event.target.value)}
          className={`${field} font-mono`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void run(true)}>
          {copy.sign}
        </Button>
        <Button variant="primary" disabled={busy || !signature} onClick={() => void run(false)}>
          {copy.verify}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-6 text-sm font-medium text-c-ink">
        {busy ? copy.calculating : status ? copy[status] : null}
      </p>
    </section>
  )
}

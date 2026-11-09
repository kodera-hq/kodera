import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'

export function buildTerminalDeployCommand(
  domain: string,
  issuer: string,
  mailbox: string
): string | null {
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
    /\.(local|internal|localhost)$/.test(domain) ||
    !/^[A-Za-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(mailbox)
  )
    return null
  try {
    const url = new URL(issuer)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      /[\s'"`$\\]/.test(issuer) ||
      !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /\.(local|internal|localhost)$/.test(url.hostname)
    )
      return null
    return `bash deploy/community/kodera-deploy.sh --domain '${domain}' --oidc-issuer '${url.href}' --oidc-origin '${url.origin}' --support-mailbox '${mailbox}' --trust-file public-trust.json --env-file kodera-generated.conf --generate-only`
  } catch {
    return null
  }
}
export function TerminalDeployCommand() {
  const { t } = useTranslation()
  const [domain, setDomain] = useState('')
  const [issuer, setIssuer] = useState('')
  const [mailbox, setMailbox] = useState('')
  const [copied, setCopied] = useState(false)
  const command = buildTerminalDeployCommand(domain, issuer, mailbox)
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-c-border p-4">
      <h3>{t('console.onboarding.studio.terminal')} · kodera-deploy.sh</h3>
      <p>{t('console.onboarding.studio.trust')}</p>
      <label className="flex flex-col gap-2 text-sm">
        {t('console.onboarding.studio.domain')}
        <input
          className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value)
            setCopied(false)
          }}
          maxLength={253}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        {t('console.onboarding.studio.issuer')}
        <input
          className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
          value={issuer}
          onChange={(e) => {
            setIssuer(e.target.value)
            setCopied(false)
          }}
          maxLength={2048}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        {t('console.onboarding.studio.support')}
        <input
          className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
          type="email"
          value={mailbox}
          onChange={(e) => {
            setMailbox(e.target.value)
            setCopied(false)
          }}
          maxLength={254}
        />
      </label>
      <code className="overflow-auto text-xs">
        {command ?? t('console.onboarding.studio.invalid')}
      </code>
      <Button
        disabled={!command}
        onClick={() => {
          if (command && navigator.clipboard)
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
        }}
      >
        {copied
          ? t('console.onboarding.studio.copied')
          : t('console.onboarding.studio.copy-command')}
      </Button>
    </section>
  )
}

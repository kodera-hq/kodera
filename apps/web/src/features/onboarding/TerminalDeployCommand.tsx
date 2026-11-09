import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { onboardingCopy } from './onboardingMessages'
import type { TemplateId } from './instantClaimClient'
export function terminalCommand(
  mode: 'script' | 'package',
  domain: string,
  issuer: string,
  client: string,
  mailbox: string,
  template: TemplateId
): string | null {
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain) ||
    /\.(local|internal|localhost|test|invalid)$/u.test(domain) ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(client) ||
    !/^[A-Za-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/u.test(mailbox)
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
      /[\s'"`$\\]/u.test(issuer) ||
      !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u.test(url.hostname) ||
      /\.(local|internal|localhost|test|invalid)$/u.test(url.hostname)
    )
      return null
    return mode === 'package'
      ? `npx create-kodera --self-host --domain '${domain}' --oidc-issuer '${url.href}' --oidc-client-id '${client}' --template '${template}' --trust-file public-trust.json --support-mailbox '${mailbox}' --source-dir . --output-dir kodera-workspace`
      : `bash deploy/community/kodera-deploy.sh --domain '${domain}' --oidc-issuer '${url.href}' --oidc-origin '${url.origin}' --oidc-client-id '${client}' --template '${template}' --support-mailbox '${mailbox}' --trust-file public-trust.json --env-file kodera-generated.conf --generate-only`
  } catch {
    return null
  }
}
export function TerminalDeployCommand({
  template = 'audiovisual-production',
}: {
  template?: TemplateId
}) {
  const { i18n } = useTranslation()
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const [mode, setMode] = useState<'script' | 'package'>('package')
  const [domain, setDomain] = useState('')
  const [issuer, setIssuer] = useState('')
  const [client, setClient] = useState('kodera-web')
  const [mailbox, setMailbox] = useState('')
  const [copied, setCopied] = useState(false)
  const command = terminalCommand(mode, domain, issuer, client, mailbox, template)
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-c-border p-4">
      <h3>{copy.command}</h3>
      <p className="text-sm text-c-ink-2">{copy.trust}</p>
      <div className="flex gap-2">
        <Button
          aria-pressed={mode === 'script'}
          onClick={() => {
            setMode('script')
            setCopied(false)
          }}
        >
          {copy.script}
        </Button>
        <Button
          aria-pressed={mode === 'package'}
          onClick={() => {
            setMode('package')
            setCopied(false)
          }}
        >
          {copy.package}
        </Button>
      </div>
      {[
        [copy.domain, domain, setDomain],
        [copy.issuer, issuer, setIssuer],
        [copy.client, client, setClient],
        [copy.mailbox, mailbox, setMailbox],
      ].map(([label, value, setter], index) => (
        <label key={index} className="flex flex-col gap-2 text-sm">
          {label as string}
          <input
            className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
            maxLength={index === 1 ? 2048 : 253}
            value={value as string}
            onChange={(e) => {
              ;(setter as (value: string) => void)(e.target.value)
              setCopied(false)
            }}
          />
        </label>
      ))}
      <code className="overflow-auto text-xs">{command ?? copy.required}</code>
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
        {copied ? copy.copied : copy.copy}
      </Button>
    </section>
  )
}

import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { HostingOfferPanel } from '../workspace/HostingOfferPanel'
import { onboardingCopy } from './onboardingMessages'
import type { ClaimedWorkspace } from './instantClaimClient'
export function ClaimWorkspaceSummary({
  workspace,
  onRetry,
  busy = false,
  refused = false,
}: {
  busy?: boolean | undefined
  refused?: boolean | undefined
  workspace: ClaimedWorkspace
  onRetry?: (() => void) | undefined
}) {
  const { i18n } = useTranslation()
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const [copied, setCopied] = useState(false)
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-4"
      aria-label={workspace.mode === 'cloud' ? copy.confirmed : copy.local}
    >
      <p role="status">{workspace.mode === 'cloud' ? copy.confirmed : copy.local}</p>
      {workspace.mode === 'local' ? (
        <>
          <p className="text-sm text-c-ink-2">{copy.uncertain}</p>
          {onRetry ? (
            <Button disabled={busy} onClick={onRetry}>
              {busy ? copy.assigning : copy.retry}
            </Button>
          ) : null}
        </>
      ) : null}
      {refused ? <p role="alert">{copy.refused}</p> : null}
      <p className="font-mono text-xs">{workspace.workspaceId}</p>
      <ul>
        {workspace.channels.map((c) => (
          <li key={c.id}>
            {c.kind === 'audio' ? '🔊' : '#'} {c.name}
          </li>
        ))}
      </ul>
      {workspace.workspaceUrl ? (
        <LinkButton href={workspace.workspaceUrl} variant="primary">
          {copy.open}
        </LinkButton>
      ) : null}
      {workspace.invitationUrl ? (
        <Button
          onClick={() => {
            if (navigator.clipboard)
              void navigator.clipboard
                .writeText(workspace.invitationUrl ?? '')
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
          }}
        >
          {copied ? copy.copied : copy.invite}
        </Button>
      ) : null}
      <HostingOfferPanel mode={workspace.offerMode} workspace={workspace} />
    </section>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { HostingOfferPanel } from '../workspace/HostingOfferPanel'
import type { ClaimedWorkspace } from './instantClaimClient'
import { OnboardingActivationChecklist } from './OnboardingActivationChecklist'
import { onboardingCopy } from './onboardingMessages'
import { completeActivationTask } from './onboardingState'

export function ClaimWorkspaceSummary({
  workspace,
  onRetry,
  onFirstMessageOrCall,
  busy = false,
  refused = false,
}: {
  busy?: boolean | undefined
  refused?: boolean | undefined
  workspace: ClaimedWorkspace
  onRetry?: (() => void) | undefined
  onFirstMessageOrCall?: (() => boolean | Promise<boolean>) | undefined
}) {
  const { i18n } = useTranslation()
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const [copied, setCopied] = useState(false)
  const [checklistSync, setChecklistSync] = useState(0)

  const seedInitialChecklistSteps = () => {
    completeActivationTask(workspace.payload.slug, 'identity_template')
    completeActivationTask(workspace.payload.slug, 'theme_sonic')
  }

  const copyInvitationAndVerify = async (): Promise<boolean> => {
    if (!workspace.invitationUrl || !navigator.clipboard?.writeText) {
      setCopied(false)
      return false
    }
    try {
      await navigator.clipboard.writeText(workspace.invitationUrl)
      setCopied(true)
      return true
    } catch {
      setCopied(false)
      return false
    }
  }

  const copySignedInvitation = async () => {
    const succeeded = await copyInvitationAndVerify()
    if (succeeded) {
      seedInitialChecklistSteps()
      completeActivationTask(workspace.payload.slug, 'invite_member')
      setChecklistSync((v) => v + 1)
    }
  }

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
        <Button onClick={() => void copySignedInvitation()}>
          {copied ? copy.copied : copy.invite}
        </Button>
      ) : null}
      <OnboardingActivationChecklist
        org={workspace.payload.slug}
        syncToken={checklistSync}
        onInviteMember={workspace.invitationUrl ? copyInvitationAndVerify : undefined}
        onFirstMessageOrCall={onFirstMessageOrCall}
      />
      <HostingOfferPanel mode={workspace.offerMode} workspace={workspace} />
    </section>
  )
}

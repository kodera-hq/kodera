import type { ClaimedWorkspace } from '../onboarding/instantClaimClient'
import { CommunityAccess } from '../docs/CommunityAccess'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { useState } from 'react'
import { cx } from '../../ui/cx'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { onboardingCopy } from '../onboarding/onboardingMessages'
export interface MigrationWorkspaceSummary {
  channels: readonly { name: string; kind: string }[]
  enabledConnectors?: readonly string[]
  payload?: { templateId?: string; themeId?: string; enabledConnectors?: readonly string[] }
}
const migrationCopy = {
  fr: {
    subject: 'Kodera — demande de migration assistée',
    greeting: 'Bonjour, je souhaite être accompagné pour migrer mon espace.',
    organisation: 'Organisation',
    current: 'Hébergement actuel',
    target: 'Hébergement souhaité',
    channels: 'Salons',
    connectors: 'Connecteurs activés',
    unspecified: 'Non précisé',
  },
  en: {
    subject: 'Kodera — assisted hosting migration',
    greeting: 'Hello, I would like assistance migrating my workspace.',
    organisation: 'Organisation',
    current: 'Current hosting',
    target: 'Requested hosting',
    channels: 'Channels',
    connectors: 'Enabled connectors',
    unspecified: 'Not specified',
  },
} as const
export type HostingMode = 'community' | 'cloud-shared' | 'cloud-dedicated'
export function publicMigrationConfiguration(
  workspace: MigrationWorkspaceSummary | ClaimedWorkspace
) {
  return {
    templateId: workspace.payload?.templateId,
    themeId: workspace.payload?.themeId,
    channels: workspace.channels.map((c) => ({ name: c.name, kind: c.kind })),
    enabledConnectors: workspace.enabledConnectors ?? [],
  }
}
export function HostingOfferPanel({
  mode,
  workspace,
  organisation,
  compact = false,
  initiallyExpanded = false,
}: {
  initiallyExpanded?: boolean
  compact?: boolean
  organisation?: string | undefined
  mode?: HostingMode | undefined
  workspace?: MigrationWorkspaceSummary | ClaimedWorkspace | undefined
}) {
  const { i18n } = useTranslation()
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [target, setTarget] = useState<HostingMode>('cloud-dedicated')
  const labels = {
    community: copy.community,
    'cloud-shared': copy.shared,
    'cloud-dedicated': copy.dedicated,
  }
  const currentMode = mode ?? 'community'
  const migration = migrationCopy[i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr']
  const configuration = workspace
    ? publicMigrationConfiguration(workspace)
    : { organisation, hostingMode: currentMode }
  const separator = i18n.resolvedLanguage?.startsWith('en') ? ': ' : '\u00a0: '
  const body = [
    migration.greeting,
    '',
    `${migration.organisation}${separator}${organisation ?? migration.unspecified}`,
    `${migration.current}${separator}${labels[currentMode]}`,
    `${migration.target}${separator}${labels[target]}`,
    `${migration.channels}${separator}${workspace?.channels.map((channel) => channel.name).join(', ') || migration.unspecified}`,
    `${migration.connectors}${separator}${workspace?.enabledConnectors?.join(', ') || migration.unspecified}`,
  ].join('\n')
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className={cx('min-w-0 rounded-lg border border-c-border', compact ? 'p-2 text-xs' : 'p-4')}
    >
      <summary className="cursor-pointer font-semibold">{copy.hosting}</summary>
      {expanded ? (
        <div className="mt-3 flex flex-col gap-3">
          <p>
            {copy.current}
            {separator}
            {labels[currentMode]}
          </p>
          <p className="text-sm text-c-ink-2">{copy.comparison}</p>
          <CommunityAccess />
          <section
            aria-label={copy.architecture}
            className={cx('grid grid-cols-1 gap-3', !compact && 'md:grid-cols-3')}
          >
            {[
              [copy.community, copy.communityArchitecture],
              [copy.shared, copy.sharedArchitecture],
              [copy.dedicated, copy.dedicatedArchitecture],
            ].map(([title, description]) => (
              <article key={title} className="rounded-md border border-c-border p-3">
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-xs text-c-ink-2">{description}</p>
              </article>
            ))}
          </section>
          <label>
            {copy.target}
            <select
              className="w-full min-w-0 rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
              value={target}
              onChange={(e) => setTarget(e.target.value as HostingMode)}
            >
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <h3>{copy.connectors}</h3>
          {!workspace ? <p>{copy.unknown}</p> : null}
          <ul>
            {(workspace?.payload?.enabledConnectors ?? []).map((id) => (
              <li key={id}>
                {id === 'frameio-review-bridge' ? 'Frame.io Review Bridge' : id} ·{' '}
                {workspace?.enabledConnectors?.includes(id) ? copy.enabled : copy.pending}
              </li>
            ))}
          </ul>
          <LinkButton
            inline
            className="text-sm"
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(migration.subject)}&body=${encodeURIComponent(body)}`}
          >
            {copy.migration}
          </LinkButton>
          <Button
            disabled={!configuration}
            onClick={() => {
              if (!configuration) return
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(configuration, null, 2)], { type: 'application/json' })
              )
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = 'kodera-workspace-configuration.json'
              anchor.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
          >
            {copy.export}
          </Button>
        </div>
      ) : null}
    </details>
  )
}

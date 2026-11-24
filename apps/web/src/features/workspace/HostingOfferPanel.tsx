import type { ClaimedWorkspace } from '../onboarding/instantClaimClient'
import { CommunityAccess } from '../docs/CommunityAccess'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { lazy, Suspense, useEffect, useState } from 'react'
import { cx } from '../../ui/cx'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { resolveBillingLocale } from '../billing/billingMessages'
import { boostVipCopy } from '../billing/boostVipMessages'
import {
  createVipPassCheckoutSession,
  createWorkspaceBoostCheckoutSession,
  createWorkspaceVipTierOffer,
  exportWorkspaceDac7Report,
  fetchWorkspaceMonetization,
  startCreatorConnectOnboardingSession,
  type WorkspaceMonetizationOverview,
} from '../billing/monetizationClient'
import type { BoostCheckoutIntent } from '../billing/WorkspaceBoostPanel'
import type {
  ConnectOnboardingState,
  VipPassCheckoutIntent,
  VipTierConfigDraft,
} from '../billing/VipMonetizationPanel'
import { onboardingCopy } from '../onboarding/onboardingMessages'

const LazyWorkspaceBoostPanel = lazy(async () => {
  const mod = await import('../billing/WorkspaceBoostPanel')
  return { default: mod.WorkspaceBoostPanel }
})

const LazyVipMonetizationPanel = lazy(async () => {
  const mod = await import('../billing/VipMonetizationPanel')
  return { default: mod.VipMonetizationPanel }
})

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    loadingMonetization: 'Chargement du module de monétisation…',
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
    loadingMonetization: 'Loading monetization module…',
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
  organisationId,
  defaultVipTierId,
  defaultVipRoleId,
  defaultVipChannelIds,
  onNavigateExternalUrl,
  compact = false,
  initiallyExpanded = false,
  monetizationInitiallyExpanded = false,
}: {
  initiallyExpanded?: boolean
  monetizationInitiallyExpanded?: boolean
  compact?: boolean
  organisation?: string | undefined
  organisationId?: string | undefined
  defaultVipTierId?: string | undefined
  defaultVipRoleId?: string | undefined
  defaultVipChannelIds?: readonly string[] | undefined
  onNavigateExternalUrl?: ((url: string) => void) | undefined
  mode?: HostingMode | undefined
  workspace?: MigrationWorkspaceSummary | ClaimedWorkspace | undefined
}) {
  const { i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const monetization = boostVipCopy(i18n.resolvedLanguage)
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [monetizationOpen, setMonetizationOpen] = useState(monetizationInitiallyExpanded)
  const [target, setTarget] = useState<HostingMode>('cloud-dedicated')
  const [overview, setOverview] = useState<WorkspaceMonetizationOverview | null>(null)

  const resolvedOrgId =
    organisationId ??
    (organisation && UUID_PATTERN.test(organisation) ? organisation : undefined)

  useEffect(() => {
    if (!expanded || !monetizationOpen || !resolvedOrgId) return
    let cancelled = false
    void fetchWorkspaceMonetization(resolvedOrgId)
      .then((loaded) => {
        if (!cancelled) setOverview(loaded)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [expanded, monetizationOpen, resolvedOrgId])

  const openExternal = (url: string) => {
    if (onNavigateExternalUrl) {
      onNavigateExternalUrl(url)
      return
    }
    window.location.assign(url)
  }

  const labels = {
    community: copy.community,
    'cloud-shared': copy.shared,
    'cloud-dedicated': copy.dedicated,
  }
  const currentMode = mode ?? 'community'
  const migration = migrationCopy[locale]
  const configuration = workspace
    ? publicMigrationConfiguration(workspace)
    : { organisation, hostingMode: currentMode }
  const separator = locale === 'en' ? ': ' : '\u00a0: '
  const body = [
    migration.greeting,
    '',
    `${migration.organisation}${separator}${organisation ?? migration.unspecified}`,
    `${migration.current}${separator}${labels[currentMode]}`,
    `${migration.target}${separator}${labels[target]}`,
    `${migration.channels}${separator}${workspace?.channels.map((channel) => channel.name).join(', ') || migration.unspecified}`,
    `${migration.connectors}${separator}${workspace?.enabledConnectors?.join(', ') || migration.unspecified}`,
  ].join('\n')

  const handleStartBoostCheckout = (intent: BoostCheckoutIntent) => {
    if (!resolvedOrgId) return
    void createWorkspaceBoostCheckoutSession(resolvedOrgId, {
      pack_code: intent.packCode,
      customer_kind: intent.customerKind,
      customer_country: intent.country,
      return_url: window.location.href,
      locale,
      withdrawal_waiver_accepted: intent.withdrawalWaiverAccepted,
      withdrawal_waiver_at: intent.withdrawalWaiverAt,
      withdrawal_waiver_statement: intent.withdrawalWaiverStatement,
    })
      .then((result) => {
        openExternal(result.checkout_url)
      })
      .catch(() => {})
  }

  const handleResumeConnect = () => {
    if (!resolvedOrgId) return
    void startCreatorConnectOnboardingSession(resolvedOrgId, {
      seller_legal_name: organisation ?? 'Kodera Creator',
      tax_residence_country: 'FR',
      refresh_url: window.location.href,
      return_url: window.location.href,
    })
      .then((result) => {
        openExternal(result.onboarding_url)
      })
      .catch(() => {})
  }

  const handleSaveVipTier = (draft: VipTierConfigDraft) => {
    if (!resolvedOrgId) return
    const roleId = defaultVipRoleId ?? overview?.vip_tiers[0]?.granted_workspace_role_id
    const channelIds =
      defaultVipChannelIds ?? overview?.vip_tiers[0]?.granted_channel_ids ?? []
    if (!roleId || channelIds.length === 0) return
    const slugCode =
      draft.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'vip-pass'
    void createWorkspaceVipTierOffer(resolvedOrgId, {
      code: slugCode,
      name: draft.name,
      billing_period: 'monthly',
      price_excl_vat_minor: draft.priceExclVatMinor,
      granted_workspace_role_id: roleId,
      granted_channel_ids: [...channelIds],
    })
      .then(() => fetchWorkspaceMonetization(resolvedOrgId).then(setOverview))
      .catch(() => {})
  }

  const handleStartVipCheckout = (intent: VipPassCheckoutIntent) => {
    const tierId = defaultVipTierId ?? overview?.vip_tiers[0]?.id
    if (!resolvedOrgId || !tierId) return
    void createVipPassCheckoutSession(resolvedOrgId, {
      tier_id: tierId,
      customer_kind: 'b2c',
      buyer_country: intent.buyerCountry,
      return_url: window.location.href,
      locale,
      withdrawal_waiver_accepted: intent.withdrawalWaiverAccepted,
      withdrawal_waiver_at: intent.withdrawalWaiverAt,
      withdrawal_waiver_statement: intent.withdrawalWaiverStatement,
    })
      .then((result) => {
        openExternal(result.checkout_url)
      })
      .catch(() => {})
  }

  const handleDownloadDac7 = (format: 'json' | 'xml') => {
    if (!resolvedOrgId) return
    void exportWorkspaceDac7Report(resolvedOrgId, format)
      .then((content) => {
        const mime = format === 'xml' ? 'application/xml' : 'application/json'
        const url = URL.createObjectURL(new Blob([content], { type: mime }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `kodera-dac7.${format}`
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      .catch(() => {})
  }

  const rawConnect = overview?.connect_account as Record<string, unknown> | null | undefined
  const connectState =
    typeof rawConnect?.['onboarding_state'] === 'string'
      ? (rawConnect['onboarding_state'] as ConnectOnboardingState)
      : undefined
  const connectAcctId =
    typeof rawConnect?.['stripe_connect_account_id'] === 'string'
      ? rawConnect['stripe_connect_account_id']
      : undefined
  const negativeBalanceMinor =
    typeof rawConnect?.['negative_balance_minor'] === 'number'
      ? rawConnect['negative_balance_minor']
      : undefined

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
          <details
            open={monetizationOpen}
            onToggle={(event) => setMonetizationOpen(event.currentTarget.open)}
            className="mt-2 rounded-md border border-c-border-soft bg-c-sunken p-3"
          >
            <summary className="cursor-pointer text-sm font-semibold text-c-ink">
              {monetization.hostingMonetizationSummary}
            </summary>
            {monetizationOpen ? (
              <Suspense
                fallback={
                  <p className="mt-3 text-xs text-c-ink-2">{migration.loadingMonetization}</p>
                }
              >
                <div className="mt-3 flex flex-col gap-4">
                  <LazyWorkspaceBoostPanel
                    onStartBoostCheckout={resolvedOrgId ? handleStartBoostCheckout : undefined}
                  />
                  <LazyVipMonetizationPanel
                    connectState={connectState}
                    stripeConnectAccountId={connectAcctId}
                    negativeBalanceMinor={negativeBalanceMinor}
                    onResumeConnectOnboarding={resolvedOrgId ? handleResumeConnect : undefined}
                    onSaveVipTier={resolvedOrgId ? handleSaveVipTier : undefined}
                    onStartVipCheckout={resolvedOrgId ? handleStartVipCheckout : undefined}
                    onDownloadDac7Report={resolvedOrgId ? handleDownloadDac7 : undefined}
                  />
                </div>
              </Suspense>
            ) : null}
          </details>
        </div>
      ) : null}
    </details>
  )
}

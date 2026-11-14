// Accessible workspace resource quota meters (`role="meter"`, zero `[style]` attributes
// under strict `style-src-attr 'none'`). Renders seats/invitations, attachment storage,
// and document/collection counts with non-colour-only normal (< 80%), warning (>= 80%),
// and limit-reached (100% / 402 / 413) states plus an upgrade CTA.

import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrganisationRole } from '../../app/Sidebar'
import { ApiProblem } from '../../api/client'
import { formatDate, formatPercent } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { StatusPill, type StatusPillState } from '../../ui/StatusPill/StatusPill'
import { resolveBillingLocale } from '../billing/billingMessages'
import { formatByteCapacity } from '../billing/workspaceOffer'
import { fetchWorkspaceQuotaUsage, type WorkspaceQuotaUsage } from './quotasApi'

// Discrete 5% width buckets — static Tailwind classes only, zero `style` attributes.
const WIDTH_BUCKETS = [
  'w-0',
  'w-[5%]',
  'w-[10%]',
  'w-[15%]',
  'w-[20%]',
  'w-[25%]',
  'w-[30%]',
  'w-[35%]',
  'w-[40%]',
  'w-[45%]',
  'w-[50%]',
  'w-[55%]',
  'w-[60%]',
  'w-[65%]',
  'w-[70%]',
  'w-[75%]',
  'w-[80%]',
  'w-[85%]',
  'w-[90%]',
  'w-[95%]',
  'w-full',
] as const

export type QuotaThresholdState = 'normal' | 'warning' | 'limit' | 'unlimited'

export function classifyQuotaState(used: number, limit: number | null): QuotaThresholdState {
  if (limit === null || limit <= 0) return 'unlimited'
  if (used >= limit) return 'limit'
  if (used / limit >= 0.8) return 'warning'
  return 'normal'
}

export function widthBucketClass(used: number, limit: number): string {
  if (used <= 0 || limit <= 0) return WIDTH_BUCKETS[0]
  if (used >= limit) return WIDTH_BUCKETS[20]
  const index = Math.min(20, Math.max(1, Math.round((used / limit) * 20)))
  return WIDTH_BUCKETS[index] ?? WIDTH_BUCKETS[0]
}

const quotaMessages = {
  fr: {
    intro:
      'Observation en temps réel des compteurs de ressources de l’espace. Les écritures sont vérifiées de manière atomique par Core.',
    measuredAt: (date: string) => `Mesuré le ${date}`,
    refresh: 'Actualiser les compteurs',
    seatsTitle: 'Sièges et invitations réservées',
    seatsValue: (used: number, limit: number) =>
      `${used.toLocaleString('fr-FR')} sur ${limit.toLocaleString('fr-FR')} sièges`,
    seatsUnlimited: (used: number) => `${used.toLocaleString('fr-FR')} sièges actifs · Illimité`,
    storageTitle: 'Stockage des pièces jointes',
    storageValue: (used: string, limit: string) => `${used} sur ${limit}`,
    storageUnlimited: (used: string) => `${used} utilisés · Illimité`,
    pagesTitle: 'Pages et collections de documents',
    pagesValue: (used: number, limit: number) =>
      `${used.toLocaleString('fr-FR')} sur ${limit.toLocaleString('fr-FR')} pages`,
    pagesUnlimited: (used: number) => `${used.toLocaleString('fr-FR')} pages actives · Illimité`,
    states: {
      normal: 'Normal',
      warning: 'Seuil d’alerte (≥ 80\u00a0%)',
      limit: 'Limite atteinte (100\u00a0%)',
      unlimited: 'Illimité',
    } satisfies Record<QuotaThresholdState, string>,
    warningNotice:
      'Au moins une ressource dépasse 80\u00a0% de la capacité incluse. Anticipez une évolution d’offre pour éviter le blocage des créations.',
    limitNotice:
      'Une limite de quota est atteinte (100\u00a0%). Les nouvelles invitations, pages ou pièces jointes correspondantes sont refusées tant que l’offre n’est pas étendue.',
    problem402Headline:
      'Quota de sièges ou de pages atteint (HTTP 402) : l’opération a été refusée par Core.',
    problem413Headline:
      'Limite de stockage des pièces jointes dépassée (HTTP 413) : le téléversement a été refusé par Core.',
    problem503Headline:
      'Vérification des quotas momentanément indisponible (HTTP 503) : aucune écriture non vérifiée n’est acceptée.',
    problemGeneric: 'Impossible de charger les compteurs de quotas pour le moment.',
    upgradeOrderCta: 'Passer à une capacité supérieure',
    upgradeSubscriptionCta: 'Consulter l’abonnement et l’offre',
    ownerUpgradeHint:
      'Demandez au propriétaire ou au responsable facturation de l’organisation d’augmenter la capacité.',
  },
  en: {
    intro:
      'Live observation of workspace resource counters. Write reservations are enforced atomically by Core.',
    measuredAt: (date: string) => `Measured on ${date}`,
    refresh: 'Refresh counters',
    seatsTitle: 'Seats and reserved invitations',
    seatsValue: (used: number, limit: number) =>
      `${used.toLocaleString('en-GB')} of ${limit.toLocaleString('en-GB')} seats`,
    seatsUnlimited: (used: number) => `${used.toLocaleString('en-GB')} active seats · Unlimited`,
    storageTitle: 'Attachment media storage',
    storageValue: (used: string, limit: string) => `${used} of ${limit}`,
    storageUnlimited: (used: string) => `${used} used · Unlimited`,
    pagesTitle: 'Documents and collection pages',
    pagesValue: (used: number, limit: number) =>
      `${used.toLocaleString('en-GB')} of ${limit.toLocaleString('en-GB')} pages`,
    pagesUnlimited: (used: number) => `${used.toLocaleString('en-GB')} active pages · Unlimited`,
    states: {
      normal: 'Normal',
      warning: 'Approaching limit (≥ 80%)',
      limit: 'Limit reached (100%)',
      unlimited: 'Unlimited',
    } satisfies Record<QuotaThresholdState, string>,
    warningNotice:
      'At least one workspace resource has reached 80% or more of its included capacity. Consider upgrading early to avoid write refusals.',
    limitNotice:
      'A workspace quota limit is reached (100%). New invitations, pages, or uploads for that resource are refused until capacity is upgraded.',
    problem402Headline:
      'Seat or page quota exhausted (HTTP 402): Core refused the write until the plan is upgraded.',
    problem413Headline:
      'Attachment storage quota exceeded (HTTP 413): Core refused the upload because media storage is full.',
    problem503Headline:
      'Quota enforcement temporarily unavailable (HTTP 503): Core refuses uncharged or unverified writes.',
    problemGeneric: 'Workspace quota counters are temporarily unavailable.',
    upgradeOrderCta: 'Upgrade workspace capacity',
    upgradeSubscriptionCta: 'View subscription and plan',
    ownerUpgradeHint:
      'Ask your organisation owner or billing manager to upgrade workspace capacity.',
  },
} as const

const PILL_BY_STATE: Record<QuotaThresholdState, StatusPillState> = {
  normal: 'success',
  warning: 'warning',
  limit: 'danger',
  unlimited: 'neutral',
}

const FILL_BY_STATE: Record<Exclude<QuotaThresholdState, 'unlimited'>, string> = {
  normal: 'bg-c-action',
  warning: 'bg-c-warn',
  limit: 'bg-c-bad',
}

export interface QuotaProblemBannerInput {
  status: number
  detail?: string | undefined
}

export interface WorkspaceQuotasPanelProps {
  org: string
  organisationId: string
  role: OrganisationRole
  onNavigate?: (() => void) | undefined
  initialUsage?: WorkspaceQuotaUsage | null | undefined
  activeProblem?: QuotaProblemBannerInput | null | undefined
}

interface QuotaMeterItemProps {
  title: string
  used: number
  limit: number | null
  summaryText: string
  stateLabel: string
  state: QuotaThresholdState
  percentLabel: string | null
}

function QuotaMeterItem({
  title,
  used,
  limit,
  summaryText,
  stateLabel,
  state,
  percentLabel,
}: QuotaMeterItemProps) {
  const labelId = useId()

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={labelId} className="text-sm font-semibold text-c-ink">
          {title}
        </span>
        <StatusPill state={PILL_BY_STATE[state]}>{stateLabel}</StatusPill>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-mono text-c-ink tabular-nums">{summaryText}</span>
        {percentLabel !== null ? (
          <span
            className={
              state === 'limit'
                ? 'font-mono text-xs font-semibold text-c-bad-ink tabular-nums'
                : state === 'warning'
                  ? 'font-mono text-xs font-semibold text-c-warn-ink tabular-nums'
                  : 'font-mono text-xs text-c-ink-3 tabular-nums'
            }
          >
            {percentLabel}
          </span>
        ) : null}
      </div>

      {limit !== null && state !== 'unlimited' ? (
        <div
          role="meter"
          aria-labelledby={labelId}
          aria-valuenow={Math.min(used, limit)}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuetext={`${summaryText} (${percentLabel ?? ''}, ${stateLabel})`}
          className="h-2 w-full overflow-hidden rounded-full bg-c-muted-2"
        >
          <div
            className={`h-full rounded-full transition-all duration-base ${FILL_BY_STATE[state]} ${widthBucketClass(used, limit)}`}
          />
        </div>
      ) : null}
    </div>
  )
}

export function WorkspaceQuotasPanel({
  org,
  organisationId,
  role,
  onNavigate,
  initialUsage,
  activeProblem,
}: WorkspaceQuotasPanelProps) {
  const { t, i18n } = useTranslation()
  const locale = resolveBillingLocale(i18n.resolvedLanguage)
  const copy = quotaMessages[locale]

  const [fetchedUsage, setFetchedUsage] = useState<WorkspaceQuotaUsage | null>(null)
  const [fetching, setFetching] = useState(initialUsage === undefined)
  const [fetchProblem, setFetchProblem] = useState<QuotaProblemBannerInput | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadUsage = useCallback(async () => {
    setFetching(true)
    setLoadFailed(false)
    setFetchProblem(null)
    try {
      const next = await fetchWorkspaceQuotaUsage(organisationId)
      setFetchedUsage(next)
    } catch (error) {
      if (error instanceof ApiProblem) {
        setFetchProblem({ status: error.status, detail: error.detail ?? undefined })
      } else {
        setLoadFailed(true)
      }
    } finally {
      setFetching(false)
    }
  }, [organisationId])

  useEffect(() => {
    if (initialUsage !== undefined) return
    let active = true
    void fetchWorkspaceQuotaUsage(organisationId)
      .then(
        (next) => {
          if (!active) return
          setFetchedUsage(next)
          setLoadFailed(false)
          setFetchProblem(null)
        },
        (error: unknown) => {
          if (!active) return
          if (error instanceof ApiProblem) {
            setFetchProblem({ status: error.status, detail: error.detail ?? undefined })
          } else {
            setLoadFailed(true)
          }
        }
      )
      .finally(() => {
        if (active) setFetching(false)
      })
    return () => {
      active = false
    }
  }, [initialUsage, organisationId])

  const usage = initialUsage !== undefined ? initialUsage : fetchedUsage
  const loading = initialUsage !== undefined ? false : fetching

  const shownProblem = activeProblem ?? fetchProblem
  const canOrder = role === 'org_owner'
  const canViewSubscription =
    role === 'org_owner' || role === 'org_admin' || role === 'org_billing'

  const upgradeAction = canOrder ? (
    <Link
      to="/$org/order"
      params={{ org }}
      onClick={onNavigate}
      className="inline-flex items-center rounded-md border border-c-border bg-c-surface px-4 py-2 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
    >
      {copy.upgradeOrderCta}
    </Link>
  ) : canViewSubscription ? (
    <Link
      to="/$org/invoices/subscription"
      params={{ org }}
      onClick={onNavigate}
      className="inline-flex items-center rounded-md border border-c-border bg-c-surface px-4 py-2 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
    >
      {copy.upgradeSubscriptionCta}
    </Link>
  ) : null

  const seatsState = usage ? classifyQuotaState(usage.usage.seats, usage.limits.seats) : 'normal'
  const storageState = usage
    ? classifyQuotaState(usage.usage.mediaBytes, usage.limits.mediaBytes)
    : 'normal'
  const pagesState = usage ? classifyQuotaState(usage.usage.pages, usage.limits.pages) : 'normal'

  const hasLimitReached =
    seatsState === 'limit' || storageState === 'limit' || pagesState === 'limit'
  const hasWarning =
    !hasLimitReached &&
    (seatsState === 'warning' || storageState === 'warning' || pagesState === 'warning')

  const pct = (used: number, limit: number | null) =>
    limit === null || limit <= 0
      ? null
      : formatPercent(Math.min(100, Math.round((used / limit) * 100)), locale)

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-c-ink-2">{copy.intro}</p>

      {shownProblem !== null ? (
        <Banner
          kind="incident"
          headline={
            shownProblem.status === 402
              ? copy.problem402Headline
              : shownProblem.status === 413
                ? copy.problem413Headline
                : shownProblem.status === 503
                  ? copy.problem503Headline
                  : copy.problemGeneric
          }
          {...(shownProblem.detail ? { detail: shownProblem.detail } : {})}
          action={
            shownProblem.status === 503 ? (
              <Button variant="secondary" size="sm" onClick={() => void loadUsage()}>
                {t('console.common.action-retry')}
              </Button>
            ) : (
              upgradeAction ?? undefined
            )
          }
        />
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton shape="block" className="h-[88px]" />
          <Skeleton shape="block" className="h-[88px]" />
          <Skeleton shape="block" className="h-[88px]" />
        </div>
      ) : loadFailed && usage === null ? (
        <div className="flex flex-col gap-3">
          <InlineAlert kind="error">{copy.problemGeneric}</InlineAlert>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => void loadUsage()}
          >
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : usage !== null ? (
        <>
          {hasLimitReached ? (
            <InlineAlert kind="error">{copy.limitNotice}</InlineAlert>
          ) : hasWarning ? (
            <InlineAlert kind="warning">{copy.warningNotice}</InlineAlert>
          ) : null}

          <div className="flex flex-col gap-4">
            <QuotaMeterItem
              title={copy.seatsTitle}
              used={usage.usage.seats}
              limit={usage.limits.seats}
              summaryText={
                usage.limits.seats === null
                  ? copy.seatsUnlimited(usage.usage.seats)
                  : copy.seatsValue(usage.usage.seats, usage.limits.seats)
              }
              state={seatsState}
              stateLabel={copy.states[seatsState]}
              percentLabel={pct(usage.usage.seats, usage.limits.seats)}
            />

            <QuotaMeterItem
              title={copy.storageTitle}
              used={usage.usage.mediaBytes}
              limit={usage.limits.mediaBytes}
              summaryText={
                usage.limits.mediaBytes === null
                  ? copy.storageUnlimited(formatByteCapacity(usage.usage.mediaBytes, locale))
                  : copy.storageValue(
                      formatByteCapacity(usage.usage.mediaBytes, locale),
                      formatByteCapacity(usage.limits.mediaBytes, locale)
                    )
              }
              state={storageState}
              stateLabel={copy.states[storageState]}
              percentLabel={pct(usage.usage.mediaBytes, usage.limits.mediaBytes)}
            />

            <QuotaMeterItem
              title={copy.pagesTitle}
              used={usage.usage.pages}
              limit={usage.limits.pages}
              summaryText={
                usage.limits.pages === null
                  ? copy.pagesUnlimited(usage.usage.pages)
                  : copy.pagesValue(usage.usage.pages, usage.limits.pages)
              }
              state={pagesState}
              stateLabel={copy.states[pagesState]}
              percentLabel={pct(usage.usage.pages, usage.limits.pages)}
            />
          </div>

          {hasLimitReached || hasWarning ? (
            upgradeAction !== null ? (
              <div className="flex flex-wrap items-center gap-3">{upgradeAction}</div>
            ) : (
              <p className="text-xs text-c-ink-3">{copy.ownerUpgradeHint}</p>
            )
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-c-border-soft pt-3">
            <span className="text-xs text-c-ink-3">
              {copy.measuredAt(formatDate(usage.measuredAt, locale))}
            </span>
            {initialUsage === undefined ? (
              <Button variant="secondary" size="sm" onClick={() => void loadUsage()}>
                {copy.refresh}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

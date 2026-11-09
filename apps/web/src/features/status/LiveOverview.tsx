// The live overview (docs/specs/02-status.md §4.2, §4.3): the header pill,
// the apps/capacity/components/plan cards, and the degraded banner. Every
// card here is a pure, prop-driven presentation piece
// (`AppsCard`/`CapacityCard`/`ComponentsCard`/`PlanCard`) — this component
// composes them and holds the overall pill/banner decision
// (`overview.ts`), which reads the tenant status call's own embedded
// `components[]` rather than the separate `/status/components` fetch, so a
// failure of that separate call (acceptance test 7) cannot take the pill or
// the banner down with it.

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { trackHistoryOpened, trackIncidentOpened } from './analytics'
import { offers } from '@/app/capabilities'
import { useClaimIncidentBanner } from '@/app/incidentBannerClaim'
import type { components } from '@/api/schema'
import { formatTime } from '@/i18n/format'
import { Button } from '@/ui/Button/Button'
import { Skeleton } from '@/ui/Skeleton/Skeleton'
import { Banner } from '@/ui/Banner/Banner'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { cx } from '@/ui/cx'
import { LINK_TEXT } from '@/ui/linkText'
import { AppsCard } from './AppsCard'
import { CapacityCard, CapacityNotMeasured } from './CapacityCard'
import type { StatusComponent } from './components'
import { componentNameKey } from './components'
import { ComponentsCard } from './ComponentsCard'
import type { HistoryDay } from './HistoryDrawer'
import { HistoryDrawer } from './HistoryDrawer'
import type { IncidentUpdate } from './IncidentDrawer'
import { IncidentDrawer } from './IncidentDrawer'
import { overallState, worstComponent } from './overview'
import { PlanCard } from './PlanCard'
import type { Incident, Subscription, TenantStatusView } from './queries'

export interface QueryState<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
}

export interface LiveOverviewProps {
  status: TenantStatusView
  lastUpdatedText: string
  canSeeBilling: boolean
  canOrder?: boolean
  componentsQuery: QueryState<StatusComponent[]> & { onRetry: () => void }
  incidentsQuery: QueryState<Incident[]>
  subscriptionQuery: QueryState<Subscription | null> & { onRetry?: () => void; forbidden?: boolean }
  historyQuery: QueryState<HistoryDay[]> & { onRetry: () => void }
  /** Lifted to the caller rather than owned here: `useTenantAvailability`
   * fetches lazily, only once the drawer opens (§11), so the query that
   * needs this flag lives one level up, alongside the rest of this screen's
   * queries. */
  historyOpen: boolean
  onHistoryOpenChange: (open: boolean) => void
  onSeeInvoices: () => void
  onSeePlans: () => void
  onTalkToUs: () => void
  onOpenTicket: (reason: 'stale' | 'incident', jobId?: string) => void
}

export function LiveOverview({
  status,
  lastUpdatedText,
  canSeeBilling,
  canOrder = false,
  componentsQuery,
  incidentsQuery,
  subscriptionQuery,
  historyQuery,
  historyOpen,
  onHistoryOpenChange,
  onSeePlans,
  onSeeInvoices,
  onTalkToUs,
  onOpenTicket,
}: LiveOverviewProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const [incidentOpen, setIncidentOpen] = useState(false)
  const historyTrigger = useRef<HTMLElement | null>(null)

  const embeddedComponents = status.components ?? []
  const state = overallState(embeddedComponents, status.agent.stale)
  const worst = worstComponent(embeddedComponents)
  // The pilot hides what Core does not serve yet (`src/app/capabilities.ts`).
  const showsComponents = offers('status-components')
  const showsIncidents = offers('status-incidents')
  const showsHistory = showsComponents && offers('availability-history')
  const incident = showsIncidents ? incidentsQuery.data?.[0] : undefined
  // This screen's banner carries the incident with its real next-update
  // time; the shell's slot yields to it for the same component rather than
  // announce it twice.
  const showsIncidentBanner = state === 'degraded' && worst !== undefined
  useClaimIncidentBanner(showsIncidentBanner ? worst?.key : undefined)

  const pillState =
    state === 'healthy'
      ? 'success'
      : state === 'stale' || state === 'unknown'
        ? 'neutral'
        : 'danger'
  const worstLabel = worst === undefined ? '' : t(componentNameKey(worst.key))
  const pillText =
    state === 'healthy'
      ? t('console.status.overview.status-all-operational')
      : state === 'unknown'
        ? t('console.status.overview.state-health-unknown')
        : state === 'stale'
          ? t('console.status.overview.status-stale')
          : t('console.status.overview.status-degraded', { component: worstLabel })

  const handleOpenHistory = (trigger: HTMLElement) => {
    historyTrigger.current = trigger
    trackHistoryOpened()
    onHistoryOpenChange(true)
  }

  const updates: IncidentUpdate[] =
    incident?.updates?.map((update) => ({ at: update.at, bodyKey: update.body_key })) ?? []

  const degradedDetail = [
    worst?.since === undefined
      ? undefined
      : t('console.status.incident.label-since', { time: formatTime(worst.since, locale) }),
    incident?.next_update_at == null
      ? undefined
      : t('console.status.incident.label-next-update', {
          time: formatTime(incident.next_update_at, locale),
        }),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')

  const handleIncidentOpenChange = (open: boolean) => {
    if (open && incident !== undefined) {
      trackIncidentOpened(worst?.key ?? '')
    }
    setIncidentOpen(open)
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="status" className="flex items-center justify-between gap-3">
        {state === 'healthy' || state === 'unknown' || !showsIncidents ? (
          <StatusPill state={pillState}>{pillText}</StatusPill>
        ) : (
          // Word + colour, and clicking it opens the same detail the
          // banner's own public-status link points to — the pill and the
          // banner headline name the same thing, so either one reaches the
          // drawer (§10's focus order names the pill as read-only, not
          // interactive, but a degraded pill is the one exception: it is
          // the shortest path to "why", which §2's alone-test condition 3
          // asks this screen to answer). Rendered as the drawer's own
          // Radix `trigger` (not a separate external button) so Escape and
          // the close button return focus here automatically — Radix's
          // FocusScope only restores focus to a trigger it manages itself.
          <IncidentDrawer
            open={incidentOpen}
            onOpenChange={handleIncidentOpenChange}
            trigger={
              <button type="button" className="text-left">
                <StatusPill state={pillState}>{pillText}</StatusPill>
              </button>
            }
            componentLabel={worstLabel}
            since={worst?.since}
            nextUpdateAt={incident?.next_update_at ?? undefined}
            impactKey={incident?.impact_key ?? undefined}
            updates={updates}
            isError={incidentsQuery.isError}
            onOpenTicket={() => onOpenTicket('incident')}
          />
        )}
        <span className="text-sm text-c-ink-3">
          {t('console.status.overview.status-updated', { duration: lastUpdatedText })}
        </span>
      </div>

      {showsIncidentBanner ? (
        <Banner
          kind="incident"
          headline={t('console.status.overview.status-degraded', { component: worstLabel })}
          {...(degradedDetail === '' ? {} : { detail: degradedDetail })}
          // With no incident drawer (and its ticket button) in the pilot, the banner itself keeps
          // the way to support.
          {...(showsIncidents
            ? {}
            : {
                action: (
                  <button
                    type="button"
                    onClick={() => onOpenTicket('incident')}
                    className={cx('text-sm font-medium', LINK_TEXT.standalone)}
                  >
                    {t('console.common.action-contact-support')}
                  </button>
                ),
              })}
        />
      ) : null}

      {state === 'stale' ? (
        <Banner
          kind="incident"
          headline={t('console.status.overview.status-stale')}
          detail={t('console.status.overview.error-heartbeat-stale', {
            duration:
              status.agent.last_heartbeat_at == null
                ? ''
                : formatTime(status.agent.last_heartbeat_at, locale),
          })}
          action={
            <button
              type="button"
              onClick={() => onOpenTicket('stale')}
              className={cx('text-sm font-medium', LINK_TEXT.standalone)}
            >
              {t('console.common.action-contact-support')}
            </button>
          }
        />
      ) : null}

      <AppsCard apps={status.apps} />

      <div className={cx('grid grid-cols-1 gap-6', showsComponents && 'md:grid-cols-2')}>
        {status.capacity === null ? (
          <CapacityNotMeasured />
        ) : (
          <CapacityCard
            participants={status.capacity.participants}
            thresholdPct={status.capacity.threshold_pct}
            upgradePrompt={status.capacity.upgrade_prompt}
            canOrder={canOrder}
            onSeePlans={onSeePlans}
            onTalkToUs={onTalkToUs}
          />
        )}
        {showsComponents ? (
          <ComponentsCard
            components={componentsQuery.data}
            isLoading={componentsQuery.isLoading}
            isError={componentsQuery.isError}
            onRetry={componentsQuery.onRetry}
            {...(showsHistory ? { onOpenHistory: handleOpenHistory } : {})}
          />
        ) : null}
      </div>

      {canSeeBilling && subscriptionQuery.isLoading ? (
        <Skeleton label={t('console.status.overview.status-loading-subscription')} />
      ) : null}
      {canSeeBilling && subscriptionQuery.isError && !subscriptionQuery.forbidden ? (
        <Banner
          kind="incident"
          headline={t('console.common.error-unavailable')}
          action={
            subscriptionQuery.onRetry ? (
              <Button onClick={subscriptionQuery.onRetry}>
                {t('console.common.action-retry')}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {!canSeeBilling || subscriptionQuery.isError || subscriptionQuery.data == null ? null : (
        <PlanCard
          packCode={subscriptionQuery.data.pack_code}
          capacityTierCode={subscriptionQuery.data.capacity_tier_code}
          nextInvoiceAt={subscriptionQuery.data.next_invoice_at ?? undefined}
          canSeeInvoices={canSeeBilling}
          onSeeInvoices={onSeeInvoices}
        />
      )}

      {showsHistory ? (
        <HistoryDrawer
          returnFocusTo={historyTrigger}
          open={historyOpen}
          onOpenChange={onHistoryOpenChange}
          days={historyQuery.data ?? []}
          isLoading={historyQuery.isLoading}
          isError={historyQuery.isError}
          onRetry={historyQuery.onRetry}
        />
      ) : null}
    </div>
  )
}

export type { TenantStatusView }
export type TenantApp = components['schemas']['TenantApp']

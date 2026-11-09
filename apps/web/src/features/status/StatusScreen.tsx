// `/{org}/status` — "Applications" (docs/specs/02-status.md). Resolves the
// organisation's tenant, then branches to the provisioning view or the live
// one from the tenant's own canonical `status` (§6's note: three enums
// disagreeing across three documents is the condition this contract exists
// to end — this screen reads the one field, never a second guess of its
// own). Every read is a query from `queries.ts`; the only state this
// component owns is which drawer is open.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@tanstack/react-router'
import { ApiProblem } from '@/api/client'
import { orgRoute } from '../../app/org-route'
import { trackStatusViewed, trackSupportFromStatus } from './analytics'
import type { MessageKey } from '@/i18n'
import { formatElapsed } from '@/i18n/format'
import { Banner } from '@/ui/Banner/Banner'
import { Button } from '@/ui/Button/Button'
import { EmptyState } from '@/ui/EmptyState/EmptyState'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { Skeleton } from '@/ui/Skeleton/Skeleton'
import type { HistoryDayComponent } from './HistoryDrawer'
import { LiveOverview } from './LiveOverview'
import { overallState } from './overview'
import { ProvisioningOverview } from './ProvisioningOverview'
import { PeoplePreparation } from '../people/PeoplePreparation'
import {
  useActiveSubscription,
  useOpenIncidents,
  useOrganisationTenant,
  useStatusComponents,
  useTenantAvailability,
  useTenantStatus,
} from './queries'
import { supportHref } from './support'
import { HelpLink } from '../support/HelpLink'
import { helpHref } from '../support/helpHref'
import { isLifecycleState } from '../support/helpTopic'

function ProvisioningSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton shape="text" className="w-1/2" />
      <Skeleton shape="text" className="w-3/4" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton shape="circle" />
            <Skeleton shape="text" className="w-1/3" />
          </div>
        ))}
      </div>
    </div>
  )
}

function LiveSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton shape="text" className="w-1/3" />
      <div className="flex flex-col gap-3">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Skeleton shape="block" className="h-[128px]" />
        <Skeleton shape="block" className="h-[128px]" />
      </div>
    </div>
  )
}

export function StatusScreen() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const router = useRouter()
  // A relative `href` is a client-side navigation (`router.navigate`'s own
  // doc comment: "an absolute href performs a full document navigation").
  // Keep these application links client-side. Reload recovery is owned by
  // the reviewed authentication boundary rather than this status screen.
  const goTo = (href: string) => void router.navigate({ href })
  const { membership } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const organisationId = membership.organisation.id
  const canSeeBilling = ['org_owner', 'org_admin', 'org_billing'].includes(membership.role)
  const canOrder = membership.role === 'org_owner'

  const tenantQuery = useOrganisationTenant(organisationId)
  const tenant = tenantQuery.data
  const statusQuery = useTenantStatus(tenant?.id)
  const componentsQuery = useStatusComponents(tenant?.id)
  const incidentsQuery = useOpenIncidents(tenant?.id)
  const subscriptionQuery = useActiveSubscription(organisationId, canSeeBilling)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyQuery = useTenantAvailability(tenant?.id, historyOpen)

  const data = statusQuery.data
  // Generic job failure can follow any job-driven lifecycle state. Only
  // ordered/provisioning use the installation timeline; supplied failed
  // steps are retained separately as last-operation diagnostics.
  const isProvisioning =
    data !== undefined && (data.status === 'ordered' || data.status === 'provisioning')

  useEffect(() => {
    if (data === undefined || (data.status !== 'active' && !isProvisioning)) return
    const state = overallState(data.components ?? [], data.agent.stale)
    const tenantState = isProvisioning ? 'provisioning' : state === 'healthy' ? 'live' : state
    trackStatusViewed(tenantState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, isProvisioning])

  // `Date.now()` is an impure read the lint rule below flags on principle,
  // but there is no state to synchronise here: "Mis à jour il y a {duration}"
  // (§4.2) is deliberately a point-in-time reading against `dataUpdatedAt` —
  // a query timestamp, not a ticking clock — recomputed exactly when a poll
  // actually lands and re-renders this component, never on its own timer. A
  // `useEffect` writing it into state would only add a second, redundant
  // render for the same value.
  // eslint-disable-next-line react-hooks/purity
  const lastUpdatedText = formatElapsed((Date.now() - statusQuery.dataUpdatedAt) / 1000, locale)

  if (tenantQuery.isLoading) {
    return <LiveSkeleton />
  }

  if (tenantQuery.isError && tenant == null) {
    return (
      <Banner
        kind="incident"
        headline={t('console.common.error-unavailable')}
        action={
          <Button onClick={() => void tenantQuery.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        }
      />
    )
  }

  if (tenant == null) {
    // §12 acceptance test 8: exactly one action, the way every `EmptyState`
    // is (README §2's own rule for the state, not something added here).
    return (
      <EmptyState
        title={t('console.status.overview.title-no-tenant')}
        body={t('console.status.overview.empty-no-tenant')}
        action={
          canOrder ? (
            <LinkButton
              href={`/${org}/order`}
              onClick={(event) => {
                event.preventDefault()
                goTo(`/${org}/order`)
              }}
            >
              {t('console.status.overview.action-order')}
            </LinkButton>
          ) : undefined
        }
      />
    )
  }

  if (statusQuery.isLoading && data === undefined) {
    return <ProvisioningSkeleton />
  }

  if (data === undefined) {
    // The first fetch never succeeded — nothing cached to fall back to, so
    // this is the whole screen rather than a banner over frozen content.
    return (
      <Banner
        kind="incident"
        headline={t('console.status.overview.error-summary-unavailable', { time: '' })}
        action={
          <Button variant="secondary" size="sm" onClick={() => void statusQuery.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        }
      />
    )
  }

  const refreshWarning = statusQuery.isError ? (
    // §5's state matrix: a refetch failure keeps the last known content
    // visible underneath ("Données du HH:MM") rather than replacing it.
    <Banner
      kind="incident"
      headline={t('console.status.overview.error-summary-unavailable', {
        time: lastUpdatedText,
      })}
      action={
        <Button variant="secondary" size="sm" onClick={() => void statusQuery.refetch()}>
          {t('console.common.action-retry')}
        </Button>
      }
    />
  ) : null

  if (data.status !== 'active' && !isProvisioning) {
    const labels: Record<string, MessageKey> = {
      ready: 'console.status.overview.state-ready',
      upgrading: 'console.status.overview.state-upgrading',
      maintenance: 'console.status.overview.state-maintenance',
      suspended: 'console.status.overview.state-suspended',
      decommissioning: 'console.status.overview.state-decommissioning',
      deleted: 'console.status.overview.state-deleted',
      failed: 'console.status.overview.state-failed',
    }
    const label = Object.hasOwn(labels, data.status) ? labels[data.status] : undefined
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-c-ink">
          {t('console.status.overview.title-state')}
        </h1>
        {label === undefined ? null : refreshWarning}
        {label === undefined ? (
          <Banner
            kind="incident"
            headline={t('console.common.error-unavailable')}
            action={
              <Button onClick={() => void statusQuery.refetch()}>
                {t('console.common.action-retry')}
              </Button>
            }
          />
        ) : (
          <p role="status">{t(label)}</p>
        )}
        {data.status === 'failed' && data.provisioning_steps.length > 0 ? (
          <ProvisioningOverview
            steps={data.provisioning_steps}
            late={false}
            diagnostic
            onSupport={(context) => goTo(supportHref(org, context.reason, context.jobId))}
          />
        ) : null}
        <HelpLink
          org={org}
          variant="primary"
          search={isLifecycleState(data.status) ? { state: data.status } : {}}
        >
          {t('console.common.action-contact-support')}
        </HelpLink>
      </div>
    )
  }

  const historyDays = (historyQuery.data ?? []).map((day) => ({
    date: day.date,
    components: day.components.map((component): HistoryDayComponent => ({
      key: component.key,
      state: component.state,
      degradedMinutes: component.degraded_minutes,
      downMinutes: component.down_minutes,
    })),
  }))

  return (
    <div className="flex flex-col gap-6">
      {refreshWarning}

      {isProvisioning ? (
        <>
          <h1 className="text-xl font-semibold text-c-ink">
            {t('console.status.overview.title-provisioning')}
          </h1>
          <ProvisioningOverview
            steps={data.provisioning_steps}
            late={data.agent.stale}
            onSupport={(context) => {
              trackSupportFromStatus(context.reason)
              goTo(supportHref(org, context.reason, context.jobId))
            }}
          />
          <PeoplePreparation org={org} role={membership.role} source="status" />
          {/* §4.1's persistent "Une question ? [Nous écrire]" link — separate
              from `ProvisioningOverview`'s own support button, which shows
              only on a failed or late step. This one is always there. */}
          <HelpLink org={org} search={{ reason: 'late' }} variant="tertiary" size="sm">
            {t('console.common.action-contact-support')}
          </HelpLink>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-c-ink">
            {t('console.status.overview.title-live', {
              organisation: membership.organisation.name,
            })}
          </h1>
          <LiveOverview
            status={data}
            lastUpdatedText={lastUpdatedText}
            canSeeBilling={canSeeBilling}
            canOrder={canOrder}
            componentsQuery={{
              data: componentsQuery.data,
              isLoading: componentsQuery.isLoading,
              isError: componentsQuery.isError,
              onRetry: () => void componentsQuery.refetch(),
            }}
            incidentsQuery={{
              data: incidentsQuery.data,
              isLoading: incidentsQuery.isLoading,
              isError: incidentsQuery.isError,
            }}
            subscriptionQuery={{
              data: subscriptionQuery.data,
              isLoading: subscriptionQuery.isLoading,
              isError: subscriptionQuery.isError,
              onRetry: () => void subscriptionQuery.refetch(),
              forbidden:
                subscriptionQuery.error instanceof ApiProblem &&
                subscriptionQuery.error.status === 403,
            }}
            historyQuery={{
              data: historyDays,
              isLoading: historyQuery.isLoading,
              isError: historyQuery.isError,
              onRetry: () => void historyQuery.refetch(),
            }}
            historyOpen={historyOpen}
            onHistoryOpenChange={setHistoryOpen}
            onSeeInvoices={() => goTo(`/${org}/invoices`)}
            onSeePlans={() => {
              goTo(`/${org}/order`)
            }}
            // Capacity, not an incident: the Aide page repeats the topic to
            // the customer, and "incident" would tell them something false.
            onTalkToUs={() => {
              goTo(helpHref(org, { topic: 'capacity' }))
            }}
            onOpenTicket={(reason, jobId) => {
              trackSupportFromStatus(reason)
              goTo(supportHref(org, reason, jobId))
            }}
          />
        </>
      )}
    </div>
  )
}

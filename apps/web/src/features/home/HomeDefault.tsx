// docs/specs/08-home.md §4.2: the default dashboard, composed from every
// card. Each card owns its own error (§5's state-matrix cell: "a failed
// call renders that card's InlineAlert with its own retry, the rest of the
// page stays usable") — this component's job is only to decide which cards
// exist for this role and to wire each one's own slice of the data.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import type { components } from '../../api/schema'
import { formatTime } from '../../i18n/format'
import { ApplicationsCard } from './ApplicationsCard'
import { AvailabilityCard } from './AvailabilityCard'
import { CapacityCard } from './CapacityCard'
import { ContractCard } from './ContractCard'
import { GreetingHeader } from './GreetingHeader'
import type { OverallHealth } from './GreetingHeader'
import { InvitationsBanner } from './InvitationsBanner'
import { InvoiceCard } from './InvoiceCard'
import { SupportCard } from './SupportCard'
import { firstNameOf } from './format-helpers'
import { invitationsPastTheirSetUpLink } from './invitations'
import { capacityBucket, trackCapacityStateShown, trackHomeViewed } from './analytics'
import {
  useActiveSubscriptionQuery,
  useHelpContextQuery,
  useLatestIssuedInvoiceQuery,
  usePendingInvitationsQuery,
  useStatusSummaryQuery,
  useTenantStatusQuery,
} from './queries'

type Me = components['schemas']['Me']

export interface HomeDefaultProps {
  org: string
  me: Me
  organisationId: string
  tenantId: string
  role: Me['organisations'][number]['role']
  online: boolean
}

function overallHealth(overall: string | undefined): OverallHealth {
  if (overall === undefined || overall === 'operational') return 'operational'
  if (overall === 'maintenance') return 'maintenance'
  return 'incident'
}

export function HomeDefault({ org, me, organisationId, tenantId, role, online }: HomeDefaultProps) {
  const { i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const canManage = role === 'org_owner' || role === 'org_admin'

  const summary = useStatusSummaryQuery(organisationId)
  const canSeeBilling = ['org_owner', 'org_admin', 'org_billing'].includes(role)

  const subscription = useActiveSubscriptionQuery(organisationId, canSeeBilling)
  const invoice = useLatestIssuedInvoiceQuery(organisationId, canSeeBilling)
  const invitationsQuery = usePendingInvitationsQuery(organisationId, canManage)
  const helpContext = useHelpContextQuery(locale, true)

  const tenantStatus = useTenantStatusQuery(tenantId)
  const forbidden = (error: unknown) => error instanceof ApiProblem && error.status === 403
  const subscriptionForbidden = forbidden(subscription.error)
  const invoiceForbidden = subscriptionForbidden || forbidden(invoice.error)

  const pendingPastTheirSetUpLink =
    invitationsQuery.data === undefined
      ? []
      : invitationsPastTheirSetUpLink(invitationsQuery.data.invitations, new Date())

  const health = overallHealth(summary.data?.overall)
  const capacity = summary.data?.capacity

  const cardsRendered =
    (capacity === null ? 0 : 1) + 1 + (canSeeBilling ? 2 : 0) + 1 + (canSeeBilling ? 1 : 0)

  const trackedRef = useRef(false)
  useEffect(() => {
    if (trackedRef.current || summary.isLoading) return
    trackedRef.current = true
    trackHomeViewed(health === 'incident' ? 'degraded' : 'active', cardsRendered)
    if (capacity != null) {
      trackCapacityStateShown(capacityBucket(capacity.participants.pct))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.isLoading])

  const frozenAt = summary.dataUpdatedAt
    ? formatTime(new Date(summary.dataUpdatedAt).toISOString(), locale)
    : undefined

  return (
    <div className="flex flex-col gap-6">
      <GreetingHeader
        org={org}
        role={role}
        firstName={firstNameOf(me)}
        now={new Date().toISOString()}
        health={health}
      />

      {canManage ? (
        <InvitationsBanner
          key={`${organisationId}:${me.id}`}
          invitations={pendingPastTheirSetUpLink}
          hasMore={invitationsQuery.data?.hasMore ?? false}
          errored={invitationsQuery.isError}
          offline={!online}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <CapacityCard
          org={org}
          canSeeBilling={canSeeBilling}
          capacity={summary.isError ? undefined : capacity}
          errored={summary.isError}
          onRetry={() => void summary.refetch()}
          frozenAt={frozenAt}
        />
        {canSeeBilling && !invoiceForbidden ? (
          <InvoiceCard
            org={org}
            subscription={subscription.isError ? undefined : subscription.data}
            dunningState={summary.data?.billing?.dunning_state}
            amountDue={summary.data?.billing?.amount_due}
            errored={subscription.isError || invoice.isError}
            onRetry={() => {
              if (subscription.isError) void subscription.refetch()
              if (invoice.isError) void invoice.refetch()
            }}
          />
        ) : null}
        <AvailabilityCard org={org} />
      </div>

      <ApplicationsCard
        apps={tenantStatus.data?.apps}
        errored={tenantStatus.isError}
        onRetry={() => void tenantStatus.refetch()}
        agentStale={tenantStatus.data?.agent.stale ?? false}
      />

      {canSeeBilling ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {subscriptionForbidden ? null : (
            <ContractCard
              subscription={subscription.data}
              errored={subscription.isError}
              onRetry={() => void subscription.refetch()}
            />
          )}
          <SupportCard
            org={org}
            helpContext={helpContext.data}
            errored={helpContext.isError}
            onRetry={() => void helpContext.refetch()}
          />
        </div>
      ) : (
        <SupportCard
          org={org}
          helpContext={helpContext.data}
          errored={helpContext.isError}
          onRetry={() => void helpContext.refetch()}
        />
      )}
    </div>
  )
}

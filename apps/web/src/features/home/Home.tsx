// docs/specs/08-home.md — the screen's own top-level branch: before a
// tenant exists at all (§5 "Empty"), while it is provisioning (§4.1), or
// once it is active (§4.2, HomeDefault). "Every one of these resolves to
// the provisioning view" (§3) is decided here, from `status-summary` and,
// when it carries no `tenant_id` yet, the one fallback call §6 names for
// that case.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import type { components } from '../../api/schema'
import { orgRoute } from '../../app/org-route'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Button } from '../../ui/Button/Button'
import { ProvisioningView } from '../status/ProvisioningView'
import { PeoplePreparation } from '../people/PeoplePreparation'
import { customerSteps, failedStep } from '../status/steps'
import type { ProvisioningStep } from '../status/steps'
import { HelpLink } from '../support/HelpLink'
import { isLifecycleState } from '../support/helpTopic'
import { HomeDefault } from './HomeDefault'
import { CreateWorkspace } from '../workspace-create/CreateWorkspace'
import { useFallbackTenantIdQuery, useStatusSummaryQuery, useTenantStatusQuery } from './queries'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { PAGE_TITLE } from '../../ui/pageTitle'

type Me = components['schemas']['Me']
type Membership = Me['organisations'][number]

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  return online
}

/** A failed provisioning step carries its reference to Aide. */
function ProvisioningSupport({
  org,
  steps,
}: {
  org: string
  steps: readonly ProvisioningStep[] | undefined
}) {
  const { t } = useTranslation()
  const failed = failedStep(customerSteps(steps ?? []))
  return (
    <HelpLink
      org={org}
      variant="secondary"
      size="sm"
      className="self-start"
      search={
        failed === undefined
          ? { reason: 'late' }
          : failed.jobId === undefined
            ? { reason: 'step-failed' }
            : { reason: 'step-failed', job_id: failed.jobId }
      }
    >
      {t('console.common.action-contact-support')}
    </HelpLink>
  )
}

export function Home() {
  const { t } = useTranslation()
  const { me, membership } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const organisationId = membership.organisation.id
  const online = useOnlineStatus()

  const summary = useStatusSummaryQuery(organisationId)
  const needsFallback = summary.data !== undefined && summary.data.tenant_id === null
  const fallbackTenant = useFallbackTenantIdQuery(organisationId, needsFallback)

  const tenantId = summary.data?.tenant_id ?? (needsFallback ? fallbackTenant.data : undefined)
  const tenantStatus = useTenantStatusQuery(tenantId ?? undefined)

  if (
    summary.isLoading ||
    (needsFallback && fallbackTenant.isLoading) ||
    (tenantId != null && tenantStatus.isLoading)
  ) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton label={t('console.common.a11y-loading')} className="h-10 w-1/2" />
        <Skeleton className="h-[256px]" />
      </div>
    )
  }

  // Only a read that never answered: a failed background refetch keeps the last answer, so a
  // form being filled is not swapped for an error.
  const summaryUnread = summary.isError && summary.data === undefined
  const fallbackUnread = fallbackTenant.isError && fallbackTenant.data === undefined
  if (tenantId == null && (summaryUnread || fallbackUnread)) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className={PAGE_TITLE}>{t('console.home.overview.title-space-state')}</h1>
        <InlineAlert kind="error">
          {t('console.home.overview.error-discovery-unavailable')}
        </InlineAlert>
        <Button onClick={() => void (summaryUnread ? summary.refetch() : fallbackTenant.refetch())}>
          {t('console.common.action-retry')}
        </Button>
      </div>
    )
  }

  if (
    tenantId == null &&
    membership.role === 'org_owner' &&
    summary.data?.billing_enabled === false
  ) {
    // A deployment that does not bill: the owner creates the workspace in one step (§4.7).
    const packCode = summary.data.workspace_pack_code
    return packCode === null ? (
      <div className="flex flex-col gap-4">
        <h1 className={PAGE_TITLE}>{t('console.home.create.title')}</h1>
        <InlineAlert kind="error">{t('console.home.create.error-unavailable')}</InlineAlert>
      </div>
    ) : (
      <CreateWorkspace
        organisationId={organisationId}
        organisationName={membership.organisation.name}
        packCode={packCode}
      />
    )
  }

  if (tenantId == null) {
    // With billing off, only the owner creates the workspace: no one else reads about ordering.
    const unbilled = summary.data?.billing_enabled === false
    return (
      <EmptyState
        headingLevel={1}
        // A member cannot order: they read who sets the organisation up, not how long an order
        // takes (docs/specs/08-home.md, acceptance 8b).
        title={t(
          membership.role === 'org_member' || unbilled
            ? 'console.home.overview.empty-title-member'
            : 'console.home.overview.empty-title'
        )}
        body={t(
          unbilled
            ? 'console.home.overview.empty-body-unbilled'
            : membership.role === 'org_member'
              ? 'console.home.overview.empty-body-member'
              : 'console.home.overview.empty-body'
        )}
        {...(membership.role === 'org_owner' && !unbilled
          ? {
              action: (
                <LinkButton href={`/${org}/order`}>
                  {t('console.home.overview.action-order')}
                </LinkButton>
              ),
            }
          : {})}
      />
    )
  }

  const status = tenantStatus.data?.status
  const isActive = status === 'active'
  const initial = status === 'ordered' || status === 'provisioning' || status === 'ready'
  if (!isActive && !initial) {
    const statuses: Partial<Record<components['schemas']['TenantStatus'], MessageKey>> = {
      upgrading: 'console.home.overview.state-upgrading',
      maintenance: 'console.home.overview.state-maintenance',
      suspended: 'console.home.overview.state-suspended',
      decommissioning: 'console.home.overview.state-decommissioning',
      deleted: 'console.home.overview.state-deleted',
      failed: 'console.home.overview.state-failed',
    }
    const message =
      status !== undefined && Object.hasOwn(statuses, status) ? statuses[status] : undefined
    return (
      <div className="flex flex-col gap-4">
        <h1 className={PAGE_TITLE}>{t('console.home.overview.title-space-state')}</h1>
        {message === undefined ? (
          <>
            <InlineAlert kind="error">
              {t('console.home.overview.error-discovery-unavailable')}
            </InlineAlert>
            <Button onClick={() => void tenantStatus.refetch()}>
              {t('console.common.action-retry')}
            </Button>
          </>
        ) : (
          <p role="status" className="text-md text-c-ink-2">
            {t(message)}
          </p>
        )}
        <div className="flex gap-3">
          <LinkButton href={`/${org}/status`} variant="secondary">
            {t('console.order.confirmation.action-go-status')}
          </LinkButton>
          <HelpLink
            org={org}
            variant="secondary"
            search={isLifecycleState(status) ? { state: status } : {}}
          >
            {t('console.home.overview.action-support')}
          </HelpLink>
        </div>
      </div>
    )
  }

  if (!isActive) {
    return (
      <ProvisioningView
        steps={tenantStatus.data?.provisioning_steps}
        refreshFailed={tenantStatus.isError}
        onRetry={() => void tenantStatus.refetch()}
        preparation={<PeoplePreparation org={org} role={membership.role} source="status" />}
        support={<ProvisioningSupport org={org} steps={tenantStatus.data?.provisioning_steps} />}
      />
    )
  }

  return (
    <HomeDefault
      org={org}
      me={me}
      organisationId={organisationId}
      tenantId={tenantId}
      role={membership.role}
      online={online}
    />
  )
}

export type { Membership }

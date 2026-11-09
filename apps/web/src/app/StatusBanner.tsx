// The shell's one banner slot (docs/specs/00-shell-and-login.md §4.5, §6):
// `GET /organisations/{organisation_id}/status-summary` is the shell's one
// call, read here and nowhere else, so navigation never fans out into four
// requests. `src/app/bannerPrecedence.ts` carries the precedence itself.

import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { trackStatusBannerShown } from './analytics'
import { coreApi } from '../api/client'
import { useSessionExpiring } from '../auth/sessionExpiry'
import type { MessageKey } from '../i18n'
import { formatDateTime, formatMoney } from '../i18n/format'
import { canViewInvoices } from '../features/invoices/permissions'
import type { OrganisationRole } from '../features/invoices/permissions'
import { Banner } from '../ui/Banner/Banner'
import { Button } from '../ui/Button/Button'
import { decideBanner } from './bannerPrecedence'
import { useIncidentBannerClaims } from './incidentBannerClaim'
import type { StatusComponent } from './bannerPrecedence'
import { useOnlineStatus } from './useOnlineStatus'

// §6 gives no explicit polling number for this call the way some other area
// specs do for theirs; 30 s is this unit's own choice — frequent enough that
// an incident appears and clears roughly when it happens, infrequent enough
// that the shell is not the busiest thing on the network tab.
const REFETCH_INTERVAL_MS = 30_000

// The maintenance banner's copy key threads its own " à " between date and
// time (`console.shell.banner.status-maintenance`), so the date and the
// time are formatted separately here rather than through `formatDateTime`,
// whose combined `dateStyle`/`timeStyle` output already joins the two the
// same way and would double it up.
const DATE_ONLY = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' })
const TIME_ONLY = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: 'Europe/Paris' })

async function fetchStatusSummary(organisationId: string) {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/status-summary', {
    params: { path: { organisation_id: organisationId } },
  })
  return data
}

// `02-status.md`'s own catalogue, not a new key here: the shell needs a
// French display name for the same closed `key` enum that screen already
// names one for, and `StatusComponent.name` (from the Core API) is a
// staff-facing English string (the contract's own example gives "Calls"),
// never a customer-facing one.
function componentLabelKey(component: StatusComponent): MessageKey {
  return `console.status.overview.label-component-${component.key}` as MessageKey
}

export interface StatusBannerProps {
  organisationId: string
  /** The URL slug, for the banner's own links (Applications, the invoice). */
  org: string
  role: OrganisationRole
  /** Classes for the slot itself. The narrow layout (`Shell`) insets the
   * banner in the page's 16 px gutter and hides the empty slot; the wide
   * layout passes none, so its banner is drawn exactly as before. */
  className?: string
}

export function StatusBanner({ organisationId, org, role, className }: StatusBannerProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const online = useOnlineStatus()
  const sessionExpiring = useSessionExpiring()
  const incidentsShownByPage = useIncidentBannerClaims()
  // The incident banner's link goes to Applications; on Applications itself
  // it would be a link to the page already open.
  const onStatusPage = useRouterState({
    select: (state) => state.location.pathname === `/${org}/status`,
  })

  const { data } = useQuery({
    queryKey: ['status-summary', organisationId],
    queryFn: () => fetchStatusSummary(organisationId),
    refetchInterval: REFETCH_INTERVAL_MS,
    // A widget-level failure, never the whole shell (§5 "Partial failure"
    // row): the nav and every other card stay usable with no banner at all
    // rather than an error screen over the one call that failed.
    throwOnError: false,
  })

  const decision = decideBanner({
    offline: !online,
    sessionExpiring,
    statusSummary: data,
    incidentsShownByPage,
  })

  useEffect(() => {
    if (decision !== undefined && decision.kind !== 'session-expiring') {
      trackStatusBannerShown(decision.kind)
    }
    // `decision` is a fresh object every render; comparing by `kind` is what
    // this effect actually means ("a NEW banner appeared"), not "the object
    // identity changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.kind])

  if (decision === undefined) return <div data-testid="shell-banner-slot" className={className} />
  // The countdown lives in its own `Dialog` (§4.7), not this slot — while it
  // has the person's attention every lower-precedence banner is suppressed,
  // which this branch does simply by rendering nothing.
  if (decision.kind === 'session-expiring')
    return <div data-testid="shell-banner-slot" className={className} />

  if (decision.kind === 'offline') {
    // `console.shell.banner.status-offline`, not the area-neutral
    // `console.common.error-offline` `login` uses (§5's own "Offline" row
    // for `shell` names cached content staying readable, which is what the
    // `{time}` placeholder is for): the last time this widget actually had
    // fresh data, or now, when it never got the chance to.
    const time = formatDateTime(data?.measured_at ?? new Date().toISOString(), 'fr')
    return (
      <div data-testid="shell-banner-slot" className={className}>
        <Banner kind="incident" headline={t('console.shell.banner.status-offline', { time })} />
      </div>
    )
  }

  if (decision.kind === 'incident') {
    const componentLabel = t(componentLabelKey(decision.component))
    // No next-update time: `status-summary` carries none for a component
    // (§6's field list stops at `since` and `message_key`), and the one
    // other timestamp it has, `measured_at`, is when the status was read,
    // not when it will next be updated. The Applications screen shows the
    // incident's own `next_update_at`; the banner links there.
    return (
      <div data-testid="shell-banner-slot" className={className}>
        <Banner
          kind="incident"
          headline={t('console.shell.banner.status-incident', {
            component: componentLabel,
            time: formatDateTime(decision.component.since, locale),
          })}
          action={
            onStatusPage ? undefined : (
              <Button variant="secondary" size="sm" asChild>
                <Link to="/$org/status" params={{ org }}>
                  {t('console.shell.banner.action-incident-details')}
                </Link>
              </Button>
            )
          }
        />
      </div>
    )
  }

  if (decision.kind === 'dunning') {
    // Only what `status-summary.billing` carries (§6): the amount due and
    // the invoice's id. It has no invoice number and no day count, and the
    // shell may not make a second call to find them (§6 Notes), so the
    // sentence names neither; the id is a link target, never text.
    //
    // The amount and the invoice are for the roles that can open Invoices.
    // Anyone else reads a neutral line: a payment is pending and the owner
    // knows, with nothing to act on and no figure.
    if (!canViewInvoices(role)) {
      return (
        <div data-testid="shell-banner-slot" className={className}>
          <Banner kind="info" headline={t('console.shell.banner.status-dunning-member')} />
        </div>
      )
    }
    const amountDue = data?.billing?.amount_due
    const invoiceId = data?.billing?.oldest_overdue_invoice_id
    return (
      <div data-testid="shell-banner-slot" className={className}>
        <Banner
          kind="incident"
          headline={
            amountDue === null || amountDue === undefined
              ? t('console.shell.banner.status-dunning-no-amount')
              : t('console.shell.banner.status-dunning', {
                  amount: formatMoney(amountDue, locale),
                })
          }
          action={
            invoiceId === null || invoiceId === undefined ? undefined : (
              <Button variant="secondary" size="sm" asChild>
                <Link to="/$org/invoices/$invoiceId" params={{ org, invoiceId }}>
                  {t('console.shell.banner.action-dunning-invoice')}
                </Link>
              </Button>
            )
          }
        />
      </div>
    )
  }

  if (decision.kind === 'capacity') {
    const limit = data?.capacity?.participants.included ?? 0
    return (
      <div data-testid="shell-banner-slot" className={className}>
        <Banner
          kind="maintenance"
          headline={t('console.shell.banner.status-capacity', { limit })}
        />
      </div>
    )
  }

  // maintenance
  const maintenance = data?.maintenance
  const scheduled =
    maintenance === null || maintenance === undefined
      ? undefined
      : new Date(maintenance.scheduled_at)
  return (
    <div data-testid="shell-banner-slot" className={className}>
      <Banner
        kind="maintenance"
        headline={t('console.shell.banner.status-maintenance', {
          date: scheduled === undefined ? '' : DATE_ONLY.format(scheduled),
          time: scheduled === undefined ? '' : TIME_ONLY.format(scheduled),
          minutes:
            maintenance === null || maintenance === undefined
              ? 0
              : Math.round(maintenance.duration_s / 60),
        })}
      />
    </div>
  )
}

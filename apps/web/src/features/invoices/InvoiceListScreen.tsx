import { BillingProfileCard } from './BillingProfileCard'
// `list` (docs/specs/05-invoices.md §4.1) — the subscription summary, the
// dunning banner, and the invoice table with its cursor pager. Every amount
// is a `Money` read straight off the Core API and formatted at the
// boundary (`src/i18n/format.ts`); nothing here sums or divides one (§6's
// own note, and `docs/specs/README.md` §5: "the console never sums, never
// divides").

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { formatDate, formatMoney } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import type { DataTableColumn } from '../../ui/DataTable/DataTable'
import { DataTable } from '../../ui/DataTable/DataTable'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { DropdownMenu } from '../../ui/DropdownMenu/DropdownMenu'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Pagination } from '../../ui/Pagination/Pagination'
import { Select } from '../../ui/Select/Select'
import type { SelectOption } from '../../ui/Select/Select'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import type { StatusPillState } from '../../ui/StatusPill/StatusPill'
import { useToast } from '../../ui/Toast/Toast'
import { cx } from '../../ui/cx'
import { LINK_TEXT } from '../../ui/linkText'
import { activeHoldUntil, classifyDunningSteps, upcomingSuspensionDate } from './dunning'
import { DunningDrawer } from './DunningDrawer'
import { canPayInvoices } from './permissions'
import { InvoicesAreaGuard } from './InvoicesAreaGuard'
import { useInvoiceActionLease } from './useInvoiceActionLease'
import { payOnline } from './payment'
import { ReturnedInvoiceLink } from './ReturnedInvoiceLink'
import type { ReturnedInvoiceAction } from './ReturnedInvoiceLink'
import {
  fetchInvoiceDownloadLink,
  useActiveSubscriptionQuery,
  useDunningQuery,
  useInvoicesQuery,
  useInvoiceQuery,
} from './queries'
import type { DunningView, Invoice, InvoiceState } from './queries'
import { rowStatus } from './rowStatus'
import type { RowStatusKind } from './rowStatus'
import { useLocale } from './useLocale'
import { vatRegimeSentenceKey } from './vatRegime'
import { helpHref } from '../support/helpHref'
import { PAGE_TITLE } from '../../ui/pageTitle'

const PILL_STATE: Record<RowStatusKind['kind'], StatusPillState> = {
  paid: 'success',
  open: 'info',
  'overdue-known': 'danger',
  'overdue-unknown': 'danger',
  'credit-note': 'neutral',
  void: 'neutral',
  draft: 'neutral',
}

const STATE_FILTER_OPTIONS: InvoiceState[] = ['issued', 'overdue', 'paid', 'void', 'credited']

function payable(invoice: Invoice): boolean {
  return invoice.state === 'issued' || invoice.state === 'overdue'
}

function InvoiceListContent() {
  const { t } = useTranslation()
  const locale = useLocale()
  const navigate = useNavigate()
  const notify = useToast()
  const [returnedAction, setReturnedAction] = useState<ReturnedInvoiceAction>()
  const { org } = orgRoute.useParams()
  const { membership } = orgRoute.useLoaderData()
  const organisationId = membership.organisation.id
  const beginAction = useInvoiceActionLease(JSON.stringify([organisationId, membership.role]))

  const dunningTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [stateFilter, setStateFilter] = useState<InvoiceState | undefined>(undefined)
  const [dunningOpen, setDunningOpen] = useState(false)
  const [payingRowId, setPayingRowId] = useState<string | undefined>(undefined)
  const [downloadingRowId, setDownloadingRowId] = useState<string | undefined>(undefined)

  const invoicesQuery = useInvoicesQuery(organisationId, stateFilter)
  const subscriptionQuery = useActiveSubscriptionQuery(organisationId)
  const dunningQuery = useDunningQuery(organisationId)

  const rows = invoicesQuery.data?.pages.flatMap((page) => page.data) ?? []
  const lastPage = invoicesQuery.data?.pages[invoicesQuery.data.pages.length - 1]

  const dunning = dunningQuery.data
  const listedOverdueInvoice =
    dunning === undefined
      ? undefined
      : rows.find((row) => row.id === dunning.oldest_overdue_invoice_id)
  const overdueInvoiceQuery = useInvoiceQuery(
    dunning?.state !== 'current' && listedOverdueInvoice === undefined
      ? (dunning?.oldest_overdue_invoice_id ?? undefined)
      : undefined,
    organisationId
  )
  const oldestOverdueInvoice = listedOverdueInvoice ?? overdueInvoiceQuery.data
  const hasOverdueBanner =
    dunning !== undefined && dunning.state !== 'current' && oldestOverdueInvoice !== undefined

  // §4.1: the customer's own dates, in a neutral voice. The headline says
  // how late the invoice is — never a day count the API did not send
  // (`days_overdue` is nullable), never an id in place of a number. The
  // second line says what happens next, and only when it is true now: an
  // open dispute (`hold_until`, still ahead) pauses the ladder and replaces
  // any suspension; otherwise a suspension date is stated only when the
  // ladder carries one still to come (`./dunning.ts`).
  function overdueBanner(view: DunningView, invoice: Invoice, now: number) {
    // Zero days is "late today", not a count to print: « en retard de 0
    // jours » reads as a defect, so it takes the no-count wording.
    const count =
      view.days_overdue !== null && view.days_overdue !== undefined && view.days_overdue > 0
        ? view.days_overdue
        : undefined
    const number = invoice.number
    const headline =
      number === null || number === undefined
        ? count === undefined
          ? t('console.invoices.list.banner-overdue-unnumbered-no-days')
          : t('console.invoices.list.banner-overdue-unnumbered', { count })
        : count === undefined
          ? t('console.invoices.list.banner-overdue-no-days', { number })
          : t('console.invoices.list.banner-overdue', { count, number })
    const holdUntil = activeHoldUntil(view.hold_until, now)
    if (holdUntil !== undefined) {
      return {
        onHold: true,
        headline,
        detail: t('console.invoices.list.detail-hold', { date: formatDate(holdUntil, locale) }),
      }
    }
    const suspensionAt = upcomingSuspensionDate(classifyDunningSteps(view.steps), now)
    return {
      onHold: false,
      headline,
      ...(suspensionAt === undefined
        ? {}
        : {
            detail: t('console.invoices.list.detail-suspension', {
              date: formatDate(suspensionAt, locale),
            }),
          }),
    }
  }

  // When the screen opened: what is "still ahead" is judged against it.
  const [now] = useState(Date.now)
  const overdue =
    hasOverdueBanner && dunning !== undefined && oldestOverdueInvoice !== undefined
      ? overdueBanner(dunning, oldestOverdueInvoice, now)
      : undefined

  function handleFilterChange(value: string) {
    setStateFilter(value === 'all' ? undefined : (value as InvoiceState))
  }

  function handleLoadMore() {
    void invoicesQuery.fetchNextPage()
  }

  async function handleDownload(invoice: Invoice) {
    const isCurrent = beginAction()
    if (!isCurrent()) return
    if (invoice.pdf_available === false) {
      // The PDF is missing, not failing: no retry to offer.
      notify({ kind: 'error', title: t('console.invoices.detail.error-pdf-unavailable') })
      return
    }
    setDownloadingRowId(invoice.id)
    try {
      const link = await fetchInvoiceDownloadLink(invoice.id)
      if (!isCurrent()) return
      setReturnedAction({ url: link.url, expires_at: link.expires_at, kind: 'pdf', isCurrent })
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch {
      if (!isCurrent()) return
      notify({ kind: 'error', title: t('console.invoices.detail.error-pdf-download-failed') })
    } finally {
      if (isCurrent()) setDownloadingRowId(undefined)
    }
  }

  async function handlePay(invoice: Invoice) {
    const isCurrent = beginAction()
    if (!isCurrent() || !canPayInvoices(membership.role)) return
    setPayingRowId(invoice.id)
    try {
      const link = await payOnline(
        invoice.id,
        `${window.location.origin}/${org}/invoices/${invoice.id}?payment=return`,
        locale,
        isCurrent
      )
      if (!isCurrent()) return
      setReturnedAction({ url: link.url, expires_at: link.expires_at, kind: 'payment', isCurrent })
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch {
      if (!isCurrent()) return
      notify({ kind: 'error', title: t('console.invoices.detail.error-payment-link') })
    } finally {
      if (isCurrent()) setPayingRowId(undefined)
    }
  }

  const columns: DataTableColumn<Invoice>[] = [
    {
      key: 'number',
      header: t('console.invoices.list.label-column-number'),
      render: (invoice) => (
        <Link
          to="/$org/invoices/$invoiceId"
          params={{ org, invoiceId: invoice.id }}
          className={cx(
            'font-mono text-sm focus-visible:ring focus-visible:outline-hidden',
            // Long numbers wrap (05-invoices.md §10); on a phone the link also
            // gets the touch-target floor.
            'narrow:inline-flex narrow:items-center',
            TOUCH_TARGET_HEIGHT,
            LINK_TEXT.standalone
          )}
        >
          {invoice.number ?? invoice.id}
        </Link>
      ),
    },
    {
      key: 'date',
      header: t('console.invoices.list.label-column-date'),
      render: (invoice) => (invoice.issued_at ? formatDate(invoice.issued_at, locale) : '—'),
    },
    {
      key: 'amount',
      header: t('console.invoices.list.label-column-amount'),
      render: (invoice) => {
        const money = invoice.total_incl_vat
        if (money === undefined || money.currency === undefined) {
          return (
            <span className="text-sm text-c-bad-ink">
              {t('console.invoices.list.error-amount-unavailable')}
            </span>
          )
        }
        const regimeKey = vatRegimeSentenceKey(invoice.vat_regime)
        return (
          <div className="flex flex-col items-end gap-1">
            <span className="font-mono text-sm text-c-ink tabular-nums">
              {formatMoney(money, locale)}
            </span>
            {regimeKey === undefined ? null : (
              <span className="text-xs text-c-ink-3">{t(regimeKey)}</span>
            )}
          </div>
        )
      },
    },
    {
      key: 'state',
      header: t('console.invoices.list.label-column-state'),
      status: true,
      render: (invoice) => {
        const status = rowStatus(invoice.state, invoice.id, dunning)
        return (
          <StatusPill state={PILL_STATE[status.kind]}>
            {status.kind === 'paid' && t('console.invoices.list.status-paid')}
            {status.kind === 'open' && t('console.invoices.list.status-open')}
            {status.kind === 'overdue-known' &&
              t('console.invoices.list.status-overdue', { count: status.days })}
            {status.kind === 'overdue-unknown' && t('console.invoices.list.status-overdue-short')}
            {status.kind === 'credit-note' && t('console.invoices.list.status-credit-note')}
            {status.kind === 'void' && t('console.invoices.list.status-void')}
            {status.kind === 'draft' && null}
          </StatusPill>
        )
      },
    },
  ]

  const stateOptions: SelectOption[] = [
    { value: 'all', label: t('console.invoices.list.option-all') },
    ...STATE_FILTER_OPTIONS.map((state) => ({
      value: state,
      label: t(
        state === 'issued'
          ? 'console.invoices.list.status-open'
          : state === 'overdue'
            ? 'console.invoices.list.status-overdue-short'
            : state === 'paid'
              ? 'console.invoices.list.status-paid'
              : state === 'void'
                ? 'console.invoices.list.status-void'
                : 'console.invoices.list.status-credit-note'
      ),
    })),
  ]

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className={PAGE_TITLE}>{t('console.invoices.list.title')}</h1>

      {hasOverdueBanner && dunning !== undefined && oldestOverdueInvoice !== undefined ? (
        <div className="flex flex-col gap-2">
          <Banner
            kind={overdue?.onHold === true ? 'info' : 'incident'}
            headline={overdue?.headline ?? ''}
            {...(overdue?.detail === undefined ? {} : { detail: overdue.detail })}
            // Entry points (§3): the banner's own pay action is the deep
            // link to the invoice, `#pay` included — the drawer below is
            // the separate "what happens next" entry the same section
            // names on its own row. `hasOverdueBanner` already guarantees
            // `oldest_overdue_invoice_id` is set in this branch.
            action={
              canPayInvoices(membership.role) ? (
                // Still possible during a dispute, but no longer the thing
                // the banner asks for.
                <Button
                  variant={overdue?.onHold === true ? 'secondary' : 'primary'}
                  size="sm"
                  asChild
                >
                  <Link
                    to="/$org/invoices/$invoiceId"
                    params={{ org, invoiceId: dunning.oldest_overdue_invoice_id as string }}
                    hash="pay"
                  >
                    {dunning.amount_due === undefined || dunning.amount_due === null
                      ? t('console.invoices.dunning.action-pay-now')
                      : t('console.invoices.list.action-pay', {
                          amount: formatMoney(dunning.amount_due, locale),
                        })}
                  </Link>
                </Button>
              ) : undefined
            }
          />
          <Button
            variant="tertiary"
            size="sm"
            className="self-start"
            ref={dunningTriggerRef}
            onClick={() => setDunningOpen(true)}
          >
            {t('console.invoices.dunning.title')}
          </Button>
        </div>
      ) : null}

      {dunningQuery.isError || overdueInvoiceQuery.isError ? (
        <div className="flex items-center gap-3">
          <InlineAlert kind="error">{t('console.invoices.list.error-dunning-invoice')}</InlineAlert>
          <Button
            variant="tertiary"
            onClick={() =>
              void (dunningQuery.isError ? dunningQuery : overdueInvoiceQuery).refetch()
            }
          >
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {subscriptionQuery.isLoading ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <span className="h-4 w-1/2 animate-pulse rounded-sm bg-c-muted-2" />
              <span className="h-4 w-1/3 animate-pulse rounded-sm bg-c-muted-2" />
            </CardBody>
          </Card>
        ) : subscriptionQuery.isError ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => void subscriptionQuery.refetch()}
              >
                {t('console.common.action-retry')}
              </Button>
            </CardBody>
          </Card>
        ) : subscriptionQuery.data == null ? null : (
          <Card>
            <CardBody className="flex flex-col gap-4 p-4">
              <h2 className="text-md font-semibold text-c-ink">
                {t('console.invoices.list.title-subscription')}
              </h2>
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-2xl font-semibold text-c-ink">
                  {subscriptionQuery.data.plan_code ?? subscriptionQuery.data.pack_code}
                </p>
                <p className="text-sm text-c-ink-3">
                  {t(
                    subscriptionQuery.data.billing_period === 'monthly'
                      ? 'console.invoices.list.label-period-monthly'
                      : 'console.invoices.list.label-period-yearly'
                  )}
                </p>
              </div>
              <p className="font-mono text-lg text-c-ink tabular-nums">
                {formatMoney(subscriptionQuery.data.price_snapshot.total_excl_vat, locale)}{' '}
                <span className="font-sans text-xs text-c-ink-3">
                  {t(
                    subscriptionQuery.data.billing_period === 'monthly'
                      ? 'console.invoices.list.label-monthly-ex-vat'
                      : 'console.invoices.list.label-annual-ex-vat'
                  )}
                </span>
              </p>
              <dl className="flex flex-col gap-2 text-sm">
                {subscriptionQuery.data.next_invoice_at ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-c-ink-3">
                      {t('console.invoices.summary.label-next-invoice')}
                    </dt>
                    <dd className="font-mono text-c-ink">
                      {formatDate(subscriptionQuery.data.next_invoice_at, locale)}
                    </dd>
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-c-ink-3">
                    {t('console.invoices.subscription.label-commitment')}
                  </dt>
                  <dd className="font-mono text-c-ink">
                    {formatDate(subscriptionQuery.data.current_period_end, locale)}
                  </dd>
                </div>
              </dl>
              <Button variant="secondary" size="sm" className="self-start" asChild>
                <Link to="/$org/invoices/subscription" params={{ org }}>
                  {t('console.invoices.list.action-change-plan')}
                </Link>
              </Button>
            </CardBody>
          </Card>
        )}

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardBody className="flex flex-col gap-3 p-4">
              <h2 className="text-md font-semibold text-c-ink">
                {t('console.invoices.summary.title-payment')}
              </h2>
              <p className="text-sm text-c-ink-2">
                {t('console.invoices.detail.hint-payment-methods')}
              </p>
              <p className="text-sm text-c-ink-2">{t('console.invoices.detail.hint-transfer')}</p>
            </CardBody>
          </Card>
          <BillingProfileCard
            organisationId={organisationId}
            loadVatStatus
            canValidateVat={canPayInvoices(membership.role)}
            taxRegime={subscriptionQuery.data?.price_snapshot.vat_regime}
          />
        </div>
      </div>

      <ReturnedInvoiceLink action={returnedAction} />

      <div className="flex items-center justify-between">
        <Select
          label={t('console.invoices.list.label-state-filter')}
          options={stateOptions}
          value={stateFilter ?? 'all'}
          onValueChange={handleFilterChange}
        />
      </div>

      {invoicesQuery.isError ? (
        <div className="flex items-center gap-3">
          <InlineAlert kind="error">{t('console.invoices.list.error-load-failed')}</InlineAlert>
          <Button variant="tertiary" size="sm" onClick={() => void invoicesQuery.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : !invoicesQuery.isLoading && rows.length === 0 && lastPage?.has_more !== true ? (
        <EmptyState
          title={t('console.invoices.list.empty-title')}
          body={t('console.invoices.list.empty-body-date', {
            date:
              subscriptionQuery.data?.next_invoice_at !== undefined &&
              subscriptionQuery.data.next_invoice_at !== null
                ? formatDate(subscriptionQuery.data.next_invoice_at, locale)
                : '—',
          })}
          action={
            <Button variant="secondary" asChild>
              <Link to="/$org/invoices/subscription" params={{ org }}>
                {t('console.invoices.list.action-view-subscription')}
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            caption={t('console.invoices.list.caption')}
            columns={columns}
            rows={rows}
            rowKey={(invoice) => invoice.id}
            actionsLabel={t('console.invoices.list.a11y-row-actions', { number: '' })}
            loading={invoicesQuery.isLoading}
            loadingLabel={t('console.invoices._.a11y-loading')}
            rowActions={(invoice) => (
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="tertiary"
                  size="sm"
                  disabled={invoice.pdf_available === false}
                  loading={downloadingRowId === invoice.id}
                  onClick={() => void handleDownload(invoice)}
                >
                  {t('console.invoices.list.action-pdf', {
                    number: invoice.number ?? invoice.id,
                  })}
                </Button>
                <DropdownMenu
                  trigger={
                    <Button
                      variant="tertiary"
                      size="sm"
                      aria-label={t('console.invoices.list.a11y-row-actions', {
                        number: invoice.number ?? invoice.id,
                      })}
                    >
                      ⋯
                    </Button>
                  }
                  label={t('console.invoices.list.a11y-row-actions', {
                    number: invoice.number ?? invoice.id,
                  })}
                  items={[
                    ...(canPayInvoices(membership.role) && payable(invoice)
                      ? [
                          {
                            label: t('console.invoices.detail.action-pay'),
                            onSelect: () => void handlePay(invoice),
                            disabled: payingRowId === invoice.id,
                          },
                        ]
                      : []),
                    {
                      label: t('console.invoices.list.action-view-detail'),
                      onSelect: () =>
                        void navigate({
                          to: '/$org/invoices/$invoiceId',
                          params: { org, invoiceId: invoice.id },
                        }),
                    },
                  ]}
                />
              </div>
            )}
          />
          <Pagination
            ariaLabel={t('console.invoices.list.a11y-pagination')}
            hasMore={lastPage?.has_more ?? false}
            hasPrevious={false}
            previousLabel={t('console.common.action-back')}
            nextLabel={t('console.common.action-load-more', { count: 25 })}
            onPrevious={() => {}}
            onNext={handleLoadMore}
            announcement={t('console.invoices.list.a11y-more-loaded', {
              count: lastPage?.data.length ?? 0,
            })}
          />
        </>
      )}

      <DunningDrawer
        returnFocusTo={dunningTriggerRef}
        dunning={dunning}
        loading={dunningQuery.isLoading}
        errored={dunningQuery.isError}
        open={dunningOpen}
        onOpenChange={setDunningOpen}
        onPayNow={
          canPayInvoices(membership.role) &&
          oldestOverdueInvoice !== undefined &&
          payable(oldestOverdueInvoice)
            ? () => {
                setDunningOpen(false)
                void handlePay(oldestOverdueInvoice)
              }
            : undefined
        }
        onContactSupport={() => void navigate({ href: helpHref(org, { topic: 'dunning' }) })}
      />
    </div>
  )
}

export function InvoiceListScreen() {
  const { membership } = orgRoute.useLoaderData()
  return (
    <InvoicesAreaGuard>
      <InvoiceListContent key={JSON.stringify([membership.organisation.id, membership.role])} />
    </InvoicesAreaGuard>
  )
}

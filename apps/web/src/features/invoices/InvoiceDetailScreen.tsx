// `detail` (docs/specs/05-invoices.md §4.2). The PDF is a pre-signed link,
// never proxied bytes (§6): `fetchInvoiceDownloadLink` only runs once the
// person asks for it, and its result is a URL this screen opens, never a
// document it renders. The bank-transfer option is withheld until the
// contract carries the issuer's bank details (owner ruling 2026-09-24,
// contract 0.12.0): until then the transfer details are the PDF's, and the
// screen points to the PDF and to support rather than to a dialog with no
// IBAN in it (§4.3). The payment button reads an active link before
// requesting issuance (`./payment.ts`). Atomic active-link reuse and
// ambiguous provider outcomes remain server requirements.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { useInvoiceActionLease } from './useInvoiceActionLease'
import { ApiProblem } from '../../api/client'
import { formatDate, formatMoney } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Breadcrumb } from '../../ui/Breadcrumb/Breadcrumb'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card/Card'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import type { StatusPillState } from '../../ui/StatusPill/StatusPill'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../ui/Table/Table'
import { useToast } from '../../ui/Toast/Toast'
import { HelpLink } from '../support/HelpLink'
import { canPayInvoices } from './permissions'
import { InvoicesAreaGuard } from './InvoicesAreaGuard'
import { payOnline } from './payment'
import { ReturnedInvoiceLink } from './ReturnedInvoiceLink'
import type { ReturnedInvoiceAction } from './ReturnedInvoiceLink'
import { fetchInvoiceDownloadLink, useInvoiceQuery } from './queries'
import { invoiceDetailRoute } from './routes'
import { rowStatus } from './rowStatus'
import type { RowStatusKind } from './rowStatus'
import { useLocale } from './useLocale'
import { vatRegimeSentenceKey } from './vatRegime'
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

type PaymentUiState = 'idle' | 'creating' | 'started' | 'failed'

function InvoiceDetailContent() {
  const { t } = useTranslation()
  const locale = useLocale()
  const notify = useToast()
  const [returnedAction, setReturnedAction] = useState<ReturnedInvoiceAction>()
  const { org, invoiceId } = invoiceDetailRoute.useParams()
  const search = invoiceDetailRoute.useSearch()
  const { membership } = orgRoute.useLoaderData()
  const beginAction = useInvoiceActionLease(JSON.stringify([org, invoiceId, membership.role]))

  const invoiceQuery = useInvoiceQuery(invoiceId, membership.organisation.id)
  const [paymentUiState, setPaymentUiState] = useState<PaymentUiState>('idle')
  const [downloading, setDownloading] = useState(false)

  // §5's "Payment return": the console draws no conclusion from `?payment=return`
  // beyond refetching — the render below reads `invoiceQuery.data.state`, never the
  // search param itself, for what to show.
  useEffect(() => {
    if (search.payment === 'return') void invoiceQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on the return redirect only
  }, [search.payment])

  async function handlePayOnline() {
    const isCurrent = beginAction()
    if (!isCurrent() || !canPayInvoices(membership.role)) return
    setPaymentUiState('creating')
    try {
      const link = await payOnline(
        invoiceId,
        `${window.location.origin}/${org}/invoices/${invoiceId}?payment=return`,
        locale,
        isCurrent
      )
      if (!isCurrent()) return
      setReturnedAction({ url: link.url, expires_at: link.expires_at, kind: 'payment', isCurrent })
      window.open(link.url, '_blank', 'noopener,noreferrer')
      setPaymentUiState('started')
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiProblem && error.type?.endsWith('/conflict') === true) {
        const refreshed = await invoiceQuery.refetch()
        if (!isCurrent()) return
        if (!refreshed.isError && refreshed.data?.state === 'paid') {
          notify({ kind: 'success', title: t('console.invoices.detail.hint-already-paid') })
          setPaymentUiState('idle')
          return
        }
      }
      setPaymentUiState('failed')
    }
  }

  async function handleDownloadPdf() {
    const isCurrent = beginAction()
    if (!isCurrent()) return
    setDownloading(true)
    try {
      const link = await fetchInvoiceDownloadLink(invoiceId)
      if (!isCurrent()) return
      setReturnedAction({ url: link.url, expires_at: link.expires_at, kind: 'pdf', isCurrent })
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch {
      if (!isCurrent()) return
      notify({ kind: 'error', title: t('console.invoices.detail.error-pdf-download-failed') })
    } finally {
      if (isCurrent()) setDownloading(false)
    }
  }

  if (invoiceQuery.isLoading) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <Skeleton shape="text" className="w-[160px]" />
        <Skeleton shape="block" className="h-[96px]" />
        <Skeleton shape="block" className="h-[192px]" />
      </div>
    )
  }

  if (invoiceQuery.isError) {
    const notFound =
      invoiceQuery.error instanceof ApiProblem && invoiceQuery.error.type?.endsWith('/not-found')
    return (
      <div className="flex flex-1 flex-col gap-6">
        <Banner
          kind="incident"
          headline={
            notFound === true
              ? t('console.invoices.detail.error-not-found')
              : t('console.common.error-unavailable')
          }
          action={
            <LinkButton variant="secondary" href={`/${org}/invoices`}>
              {t('console.invoices.list.title')}
            </LinkButton>
          }
        />
      </div>
    )
  }

  const invoice = invoiceQuery.data
  if (invoice === undefined) return null

  const status = rowStatus(invoice.state, invoice.id, undefined)
  const statusLabel =
    status.kind === 'paid'
      ? t('console.invoices.list.status-paid')
      : status.kind === 'open'
        ? t('console.invoices.list.status-open')
        : status.kind === 'overdue-known'
          ? t('console.invoices.list.status-overdue', { count: status.days })
          : status.kind === 'overdue-unknown'
            ? t('console.invoices.list.status-overdue-short')
            : status.kind === 'credit-note'
              ? t('console.invoices.list.status-credit-note')
              : status.kind === 'void'
                ? t('console.invoices.list.status-void')
                : ''

  const canPay =
    canPayInvoices(membership.role) && (invoice.state === 'issued' || invoice.state === 'overdue')
  const regimeKey = vatRegimeSentenceKey(invoice.vat_regime)
  const pdfAvailable = invoice.pdf_available !== false
  // The failed payment card offers the PDF itself; the one below would repeat it.
  const offersPdfInPaymentCard = canPay && paymentUiState === 'failed' && pdfAvailable

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Breadcrumb
        ariaLabel={t('console.invoices._.a11y-breadcrumb')}
        items={[
          { label: t('console.invoices.list.title'), href: `/${org}/invoices` },
          { label: t('console.invoices.detail.title', { number: invoice.number ?? invoice.id }) },
        ]}
      />
      <div>
        <h1 className={PAGE_TITLE}>
          {t('console.invoices.detail.title', { number: invoice.number ?? invoice.id })}
        </h1>
        <div className="mt-1 flex items-center gap-2">
          <StatusPill state={PILL_STATE[status.kind]}>{statusLabel}</StatusPill>
          {invoice.due_at ? (
            <span className="text-sm text-c-ink-3">
              {t('console.invoices.detail.label-due', { date: formatDate(invoice.due_at, locale) })}
            </span>
          ) : null}
        </div>
      </div>

      <ReturnedInvoiceLink action={returnedAction} />

      {canPay ? (
        <Card>
          <CardHeader>
            <h2 className="text-md font-semibold text-c-ink">
              {t('console.invoices.detail.title-to-pay')}
            </h2>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {invoice.amount_due ? (
              <p className="font-mono text-2xl font-medium text-c-ink tabular-nums">
                {formatMoney(invoice.amount_due, locale)}
              </p>
            ) : null}

            {paymentUiState === 'started' ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-c-ink">
                  {t('console.invoices.detail.title-payment-link-ready')}
                </p>
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => void handlePayOnline()}
                >
                  {t('console.invoices.detail.action-pay')}
                </Button>
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => void invoiceQuery.refetch()}
                >
                  {t('console.invoices.detail.action-check-payment')}
                </Button>
              </div>
            ) : paymentUiState === 'failed' ? (
              // §5 "payment", link creation fails: the transfer details are
              // the PDF's, so the PDF is promoted to the primary action, first
              // in reading order, with support and a retry after it — and
              // support is the primary action when there is no PDF.
              <div className="flex flex-col gap-2">
                <InlineAlert kind="error">
                  {t(
                    pdfAvailable
                      ? 'console.invoices.detail.error-payment-link'
                      : 'console.invoices.detail.error-payment-link-no-pdf'
                  )}
                </InlineAlert>
                <div className="flex flex-wrap items-center gap-3">
                  {pdfAvailable ? (
                    <Button
                      variant="primary"
                      loading={downloading}
                      onClick={() => void handleDownloadPdf()}
                    >
                      {t('console.invoices.detail.action-pdf')}
                    </Button>
                  ) : null}
                  <HelpLink
                    org={org}
                    search={{ invoiceNumber: invoice.number ?? invoice.id }}
                    variant={pdfAvailable ? 'secondary' : 'primary'}
                  >
                    {t('console.common.action-contact-support')}
                  </HelpLink>
                  <Button variant="secondary" onClick={() => void handlePayOnline()}>
                    {t('console.common.action-retry')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  loading={paymentUiState === 'creating'}
                  onClick={() => void handlePayOnline()}
                  aria-describedby="invoice-pay-opens-tab"
                >
                  {t('console.invoices.detail.action-pay')}
                </Button>
              </div>
            )}
            <p id="invoice-pay-opens-tab" className="sr-only">
              {t('console.common.a11y-opens-new-tab')}
            </p>
            <p className="text-sm text-c-ink-3">
              {t('console.invoices.detail.hint-payment-methods')}
            </p>
            {pdfAvailable && paymentUiState !== 'failed' ? (
              <p className="text-sm text-c-ink-3">{t('console.invoices.detail.hint-transfer')}</p>
            ) : null}
            {search.payment === 'return' && invoice.state !== 'paid' ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-c-ink-3">
                  {t('console.invoices.detail.hint-payment-pending')}
                </p>
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => void invoiceQuery.refetch()}
                >
                  {t('console.invoices.detail.action-refresh')}
                </Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="text-md font-semibold text-c-ink">
            {t('console.invoices.detail.title-lines')}
          </h2>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Table
            caption={t('console.invoices.detail.caption-lines', {
              number: invoice.number ?? invoice.id,
            })}
          >
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">
                  {t('console.invoices.detail.title-lines')}
                </TableHeaderCell>
                {/* Each line is `total_excl_vat`: the column says so. TTC is
                    the list's column and the totals' last row, never a line's. */}
                <TableHeaderCell scope="col" status>
                  {t('console.invoices.detail.label-column-amount-excl-tax')}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {invoice.lines.map((line, index) => (
                <TableRow key={`${line.description}-${index}`}>
                  <TableCell>{line.description}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMoney(line.total_excl_vat, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {regimeKey === undefined ? null : <p className="text-sm text-c-ink-3">{t(regimeKey)}</p>}

          <DefinitionList
            items={[
              {
                term: t('console.invoices.detail.label-total-excl-tax'),
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(invoice.total_excl_vat, locale)}
                  </span>
                ),
              },
              {
                term: t('console.invoices.detail.label-tax', {
                  rate: (invoice.lines[0]?.vat_rate_bp ?? 0) / 100,
                }),
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(invoice.vat_amount, locale)}
                  </span>
                ),
              },
              {
                term: t('console.invoices.detail.label-total-incl-tax'),
                description: (
                  <span className="font-mono tabular-nums">
                    {formatMoney(invoice.total_incl_vat, locale)}
                  </span>
                ),
              },
            ]}
          />
        </CardBody>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-c-ink-3">
          {invoice.issued_at
            ? t('console.invoices.detail.label-issued', {
                date: formatDate(invoice.issued_at, locale),
              })
            : null}
          {invoice.external_ref ? (
            <>
              {' · '}
              {t('console.invoices.detail.label-reference', { reference: invoice.external_ref })}
            </>
          ) : null}
        </p>
        {offersPdfInPaymentCard ? null : (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={!pdfAvailable}
              loading={downloading}
              onClick={() => void handleDownloadPdf()}
            >
              {t('console.invoices.detail.action-pdf')}
            </Button>
            {pdfAvailable ? null : (
              <span className="text-sm text-c-bad-ink">
                {t('console.invoices.detail.error-pdf-unavailable')}
              </span>
            )}
          </div>
        )}
        <HelpLink
          org={org}
          search={{ invoiceNumber: invoice.number ?? invoice.id }}
          variant="tertiary"
          className="self-start"
        >
          {t('console.invoices.detail.action-support')}
        </HelpLink>
      </div>
    </div>
  )
}

export function InvoiceDetailScreen() {
  const { org, invoiceId } = invoiceDetailRoute.useParams()
  const { membership } = orgRoute.useLoaderData()
  return (
    <InvoicesAreaGuard>
      <InvoiceDetailContent
        key={JSON.stringify([org, invoiceId, membership.organisation.id, membership.role])}
      />
    </InvoicesAreaGuard>
  )
}

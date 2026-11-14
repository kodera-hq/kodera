// `confirmation` — 01-order.md §4.4. The order does not start provisioning
// (§6): the copy states plainly that the space opens within one business
// day, and never implies otherwise. `Order.invoice_id` absent is
// `billing_pending` — not an error (§6) — and a payment link that cannot be
// created or fails checkout host validation falls back to bank transfer with
// a retry, never a dead end. Its support action goes through Aide like every
// other (06-support.md §4.0), and offers the existing People preparation
// route to managers. Domain setup remains withheld while it provides only a
// read-only slice.

import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { coreApi } from '../../api/client'
import { formatMoney } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import {
  isAllowedCheckoutRedirectUrl,
  isSafePresignedDownloadUrl,
} from '../billing/checkoutUrl'
import { useInvoiceQuery, useOrderQuery } from './api'
import { useCreatePaymentLinkMutation } from './mutations'
import { HelpLink } from '../support/HelpLink'
import { PeoplePreparation } from '../people/PeoplePreparation'
import { Link } from '@tanstack/react-router'
import { SUBMISSION_HELD } from './submission'
import type { PeoplePreparationProps } from '../people/PeoplePreparation'

/** A GET, not a write — but user-triggered and one-shot (open the PDF in a
 * new tab), so `useMutation` fits its lifecycle better than a cached query
 * that a click would otherwise have to invalidate to re-fire. */
function useInvoiceDownload() {
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data } = await coreApi().GET('/invoices/{invoice_id}/download', {
        params: { path: { invoice_id: invoiceId } },
      })
      return data
    },
    onSuccess: (data) => {
      if (data !== undefined && isSafePresignedDownloadUrl(data.url, data.expires_at)) {
        window.open(data.url, '_blank', 'noopener,noreferrer')
      }
    },
  })
}

export interface ConfirmationStepProps {
  org: string
  role: PeoplePreparationProps['role']
  orderId: string
  firstName: string
  onGoToStatus: () => void
}

export function ConfirmationStep({
  org,
  role,
  orderId,
  firstName,
  onGoToStatus,
}: ConfirmationStepProps) {
  const { t } = useTranslation()
  const orderQuery = useOrderQuery(orderId)
  const order = orderQuery.data
  const invoiceQuery = useInvoiceQuery(order?.invoice_id ?? undefined)
  const invoice = invoiceQuery.data
  const download = useInvoiceDownload()
  const paymentLink = useCreatePaymentLinkMutation()
  const [paymentKey] = useState(() => crypto.randomUUID())

  useEffect(() => {
    if (invoice === undefined) return
    paymentLink.mutate({
      invoiceId: invoice.id,
      returnUrl: `https://app.kodera.io/invoices/${invoice.id}`,
      locale: 'fr',
      idempotencyKey: paymentKey,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id])

  if (orderQuery.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8" />
        <Skeleton className="h-[96px]" />
      </div>
    )
  }

  if (orderQuery.isError || order === undefined) {
    return (
      <Banner
        kind="incident"
        headline={t('console.order.confirmation.error-invoice-deferred')}
        action={
          <HelpLink org={org} search={{ topic: 'order' }} variant="secondary">
            {t('console.common.action-contact-support')}
          </HelpLink>
        }
      />
    )
  }

  const billingPending = order.invoice_id === null || order.invoice_id === undefined
  const verifiedCheckoutUrl =
    paymentLink.isSuccess &&
    paymentLink.data !== undefined &&
    paymentLink.data.state === 'active' &&
    isSafePresignedDownloadUrl(paymentLink.data.url, paymentLink.data.expires_at) &&
    isAllowedCheckoutRedirectUrl(paymentLink.data.url)
      ? paymentLink.data.url
      : null
  const paymentLinkFailed =
    paymentLink.isError || (paymentLink.isSuccess && verifiedCheckoutUrl === null)

  return (
    <Card>
      <CardBody className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-c-ink">
            {t('console.order.confirmation.title', { firstName })}
          </h1>
          <p className="mt-1 text-sm text-c-ink-3">{t('console.order.confirmation.subtitle')}</p>
          <p className="mt-1 text-sm text-c-ink-3">{t('console.order.confirmation.status-eta')}</p>
        </div>

        {billingPending ? (
          <Banner kind="info" headline={t('console.order.confirmation.error-invoice-deferred')} />
        ) : invoice === undefined ? (
          <Skeleton className="h-[64px]" />
        ) : (
          <div className="flex flex-col gap-3">
            <DefinitionList
              items={[
                {
                  term: t('console.order.confirmation.label-invoice', {
                    number: invoice.number ?? '—',
                  }),
                  description: formatMoney(invoice.total_incl_vat, 'fr'),
                },
              ]}
            />
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => download.mutate(invoice.id)}
                loading={download.isPending}
              >
                {t('console.order.confirmation.action-download-invoice')}
              </Button>
              {verifiedCheckoutUrl !== null ? (
                <LinkButton href={verifiedCheckoutUrl} target="_blank">
                  {t('console.order.confirmation.action-pay')}
                </LinkButton>
              ) : null}
            </div>
            {paymentLinkFailed ? (
              <Banner
                kind="incident"
                headline={t('console.order.confirmation.error-payment-link')}
                action={
                  <Button
                    onClick={() =>
                      paymentLink.mutate({
                        invoiceId: invoice.id,
                        returnUrl: `https://app.kodera.io/invoices/${invoice.id}`,
                        locale: 'fr',
                        idempotencyKey: crypto.randomUUID(),
                      })
                    }
                  >
                    {t('console.common.action-retry')}
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-c-ink-3">
                {t('console.order.confirmation.hint-transfer')}
              </p>
            )}
          </div>
        )}

        <PeoplePreparation org={org} role={role} source="order" />

        {SUBMISSION_HELD ? null : (
          // The order carries the accepted CGV and DPA; the workspace comes after it, never before.
          <Button asChild>
            <Link to="/$org/workspace" params={{ org }}>
              {t('console.order.confirmation.action-create-workspace')}
            </Link>
          </Button>
        )}
        <Button onClick={onGoToStatus}>{t('console.order.confirmation.action-go-status')}</Button>
      </CardBody>
    </Card>
  )
}

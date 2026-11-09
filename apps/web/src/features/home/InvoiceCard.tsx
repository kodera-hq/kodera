// docs/specs/08-home.md §4.2/§4.6: the next-invoice card, and its dunning
// (overdue) variant. §9: `subscriptions` or `invoices` failing shows
// `error-invoice-unavailable` on this card alone. §5 permission-denied row:
// absent entirely for `member`, handled by the caller not rendering this
// component at all rather than by a prop here.

import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import { formatDate, formatMoney } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { PriceLine } from '../../ui/PriceLine/PriceLine'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { billingPeriodKey } from './format-helpers'
import { trackCardLinkClicked } from './analytics'

type Subscription = components['schemas']['Subscription']
type DunningState = components['schemas']['DunningState']
type Money = components['schemas']['Money']

export interface InvoiceCardProps {
  org: string
  subscription: Subscription | null | undefined
  dunningState?: DunningState | undefined
  /** `status-summary.billing.amount_due` — the only overdue figure Home's
   * own call table carries (§6); there is no separate dunning fetch here. */
  amountDue?: Money | null | undefined
  onRetry?: () => void
  errored?: boolean
}

export function InvoiceCard({
  org,
  subscription,
  dunningState,
  amountDue,
  errored = false,
  onRetry,
}: InvoiceCardProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  if (subscription === undefined && !errored) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <Skeleton label={t('console.common.a11y-loading')} className="h-[96px]" />
        </CardBody>
      </Card>
    )
  }

  if (errored) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm font-medium text-c-ink-3">
            {t('console.home.overview.label-next-invoice')}
          </p>
          <InlineAlert kind="warning">
            {t('console.home.overview.error-invoice-unavailable')}
          </InlineAlert>
          {onRetry ? <Button onClick={onRetry}>{t('console.common.action-retry')}</Button> : null}
          <LinkButton
            href={`/${org}/invoices`}
            variant="tertiary"
            size="sm"
            onClick={() => trackCardLinkClicked('invoice')}
          >
            {t('console.home.overview.action-see-invoices')}
          </LinkButton>
        </CardBody>
      </Card>
    )
  }

  if (
    subscription === null ||
    subscription === undefined ||
    subscription.next_invoice_at === undefined ||
    subscription.next_invoice_at === null
  ) {
    return null
  }

  const overdue = dunningState !== undefined && dunningState !== 'current'
  const amount = formatMoney(subscription.price_snapshot.total_excl_vat, locale)
  const cycle = t(billingPeriodKey(subscription.billing_period))
  const nextInvoiceDate = formatDate(subscription.next_invoice_at, locale)

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium text-c-ink-3">
          {t('console.home.overview.label-next-invoice')}
        </p>
        <PriceLine label="" amount={amount} emphasis />
        <p className="text-xs text-c-ink-3">
          {t('console.home.overview.hint-next-invoice', { cycle, date: nextInvoiceDate })}
        </p>
        {overdue && amountDue !== undefined && amountDue !== null ? (
          <InlineAlert kind="warning">
            {t('console.home.overview.status-invoice-overdue', {
              amount: formatMoney(amountDue, locale),
            })}
          </InlineAlert>
        ) : null}
        <LinkButton
          href={`/${org}/invoices`}
          variant="tertiary"
          size="sm"
          onClick={() => trackCardLinkClicked('invoice')}
        >
          {t('console.home.overview.action-see-invoices')}
        </LinkButton>
      </CardBody>
    </Card>
  )
}

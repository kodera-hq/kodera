// docs/specs/08-home.md §4.2: the contract card, inverse (slate) tone. There
// is no `GET .../dpa` list endpoint in the pinned contract — only
// `POST .../dpa` (generate) and `GET .../dpa/{dpa_id}` (one document by an
// id nothing on this screen has) — so the DPA version/"Lire" row this
// screen's own wireframe shows is not rendered; an eighth contract gap
// beyond the seven §6.5 already lists, reported in the unit's own summary
// rather than invented as a path here (docs/dev/API_CLIENT.md: "a path
// invented here is a path that will not exist").

import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import { formatDate } from '../../i18n/format'
import { Card, CardBody } from '../../ui/Card/Card'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'

type Subscription = components['schemas']['Subscription']

export interface ContractCardProps {
  subscription: Subscription | null | undefined
  errored?: boolean
  onRetry?: () => void
}

export function ContractCard({ subscription, errored = false, onRetry }: ContractCardProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  if (errored)
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <InlineAlert kind="warning">{t('console.common.error-unavailable')}</InlineAlert>
          {onRetry ? <Button onClick={onRetry}>{t('console.common.action-retry')}</Button> : null}
        </CardBody>
      </Card>
    )

  if (subscription === undefined) {
    return (
      <Card tone="inverse">
        <CardBody className="flex flex-col gap-3">
          <Skeleton tone="inverse" label={t('console.common.a11y-loading')} className="h-[80px]" />
        </CardBody>
      </Card>
    )
  }

  if (subscription === null) {
    return null
  }

  return (
    <Card tone="inverse">
      <CardBody className="flex flex-col gap-2">
        <p className="text-sm font-medium text-c-on-inverse-dim">
          {t('console.home.overview.title-contract')}
        </p>
        <p className="text-sm text-c-on-inverse">
          {/* `pack_code` is a slug ("visio-docs"), not the customer-facing
              pack name the design shows ("Business Plus") — the contract
              carries no display name for it, so it is rendered as the
              monospace code a customer would recognise from an order
              confirmation rather than as invented prose. */}
          <span className="font-mono">{subscription.pack_code}</span> ·{' '}
          {t(
            subscription.billing_period === 'yearly'
              ? 'console.home.overview.label-billing-period-yearly'
              : 'console.home.overview.label-billing-period-monthly'
          )}
        </p>
        <p className="text-sm text-c-on-inverse-dim">
          {t('console.home.overview.label-commitment', {
            date: formatDate(subscription.current_period_end, locale),
          })}
        </p>
      </CardBody>
    </Card>
  )
}

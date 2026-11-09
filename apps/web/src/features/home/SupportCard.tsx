// docs/specs/08-home.md §4.2, §6.5's fifth contract gap: `HelpContext.sla`
// carries the tier, the target minutes and the business hours label, but no
// contact identity — so the card reads the promise without a name
// ("Nous vous répondons sous {hours} heures ouvrées"), not the delivered
// design's "David vous répond".

import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import { minutesToWholeHours } from '../../i18n/format'
import { Card, CardBody } from '../../ui/Card/Card'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { trackCardLinkClicked } from './analytics'
import { HelpLink } from '../support/HelpLink'

type HelpContext = components['schemas']['HelpContext']

export interface SupportCardProps {
  org: string
  helpContext: HelpContext | undefined
  errored?: boolean
  onRetry?: () => void
}

export function SupportCard({ org, helpContext, errored = false, onRetry }: SupportCardProps) {
  const { t } = useTranslation()

  if (errored)
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <InlineAlert kind="warning">{t('console.common.error-unavailable')}</InlineAlert>
          {onRetry ? <Button onClick={onRetry}>{t('console.common.action-retry')}</Button> : null}
        </CardBody>
      </Card>
    )

  if (helpContext === undefined) {
    return (
      <Card tone="inverse">
        <CardBody className="flex flex-col gap-3">
          <Skeleton tone="inverse" label={t('console.common.a11y-loading')} className="h-[80px]" />
        </CardBody>
      </Card>
    )
  }

  const targetMinutes = helpContext.sla?.first_response_target_minutes
  // No SLA on the entitlement (a pack without a support tier) — the design
  // has no wording for this case either, so the card is omitted rather than
  // reading "sous undefined heures".
  if (targetMinutes === undefined) {
    return null
  }
  const hours = minutesToWholeHours(targetMinutes)

  return (
    <Card tone="inverse">
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium text-c-on-inverse">
          {t('console.home.overview.title-support', { hours })}
        </p>
        <p className="text-sm text-c-on-inverse-dim">{t('console.home.overview.hint-support')}</p>
        <HelpLink
          org={org}
          variant="secondary"
          size="sm"
          onClick={() => trackCardLinkClicked('support')}
        >
          {t('console.home.overview.action-support')}
        </HelpLink>
      </CardBody>
    </Card>
  )
}

// docs/specs/08-home.md §4.2/§4.4: the capacity gauge card. §8's validation
// rule owns the one hard case: `capacity: null` hides the card entirely,
// never a 0 % gauge.

import { useTranslation } from 'react-i18next'
import type { components } from '../../api/schema'
import { formatTime } from '../../i18n/format'
import { Card, CardBody } from '../../ui/Card/Card'
import { Gauge } from '../../ui/Gauge/Gauge'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { cx } from '../../ui/cx'
import { LINK_TEXT } from '../../ui/linkText'
import { trackCardLinkClicked } from './analytics'
import { HelpLink } from '../support/HelpLink'

type CapacityGauge = components['schemas']['CapacityGauge']

export interface CapacityCardProps {
  org: string
  canSeeBilling?: boolean
  /** `undefined` = loading, `null` = absent (§8), the object = loaded. */
  capacity: CapacityGauge | null | undefined
  errored?: boolean
  onRetry?: () => void
  frozenAt?: string | undefined
}

export function CapacityCard({
  org,
  canSeeBilling = false,
  capacity,
  errored = false,
  onRetry,
  frozenAt,
}: CapacityCardProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  if (capacity === undefined && !errored) {
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
            {t('console.home.overview.label-capacity')}
          </p>
          <InlineAlert kind="warning">
            {t('console.home.overview.error-summary-unavailable', { time: frozenAt ?? '' })}
          </InlineAlert>
          {onRetry === undefined ? null : (
            <button
              type="button"
              onClick={onRetry}
              className={cx('self-start text-sm font-semibold', LINK_TEXT.standalone)}
            >
              {t('console.common.action-retry')}
            </button>
          )}
        </CardBody>
      </Card>
    )
  }

  // `capacity: null`, or `included` of 0 → hidden entirely (§8).
  if (capacity === null || capacity === undefined || capacity.participants.included === 0) {
    return null
  }

  const { participants, threshold_pct: thresholdPct, upgrade_prompt: upgradePrompt } = capacity
  const atLimit = participants.pct >= 100

  const statusLabel = !upgradePrompt
    ? undefined
    : atLimit
      ? t('console.home.overview.status-capacity-at-limit', {
          time: capacity.measured_at ? formatTime(capacity.measured_at, locale) : '',
        })
      : t('console.home.overview.status-capacity-near-limit')

  // "It states what happens at the cap before it offers anything" (§4.4):
  // the consequence, in a full sentence, comes before the plans link — reused
  // from the status area's own wording, since Home has no key of its own for
  // it and the sentence is the same fact either screen would state.
  const consequence = atLimit
    ? t('console.status.overview.error-capacity-reached', { limit: participants.included })
    : t('console.status.overview.warning-capacity-near-limit', { limit: participants.included })

  const action = upgradePrompt ? (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-c-ink-2">{consequence}</p>
      <div className="flex flex-wrap gap-3">
        {canSeeBilling ? (
          <LinkButton
            href={`/${org}/invoices`}
            variant="tertiary"
            size="sm"
            onClick={() => trackCardLinkClicked('capacity')}
          >
            {t('console.home.overview.action-see-plans')}
          </LinkButton>
        ) : null}
        {atLimit ? (
          <HelpLink
            org={org}
            search={{ topic: 'capacity' }}
            variant="tertiary"
            size="sm"
            onClick={() => trackCardLinkClicked('capacity')}
          >
            {t('console.status.overview.action-talk-to-us')}
          </HelpLink>
        ) : null}
      </div>
    </div>
  ) : undefined

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium text-c-ink-3">
          {t('console.home.overview.label-capacity')}
        </p>
        <Gauge
          label={t('console.home.overview.label-capacity')}
          value={participants.pct}
          max={100}
          valueText={t('console.home.overview.status-capacity', {
            used: participants.used,
            limit: participants.included,
          })}
          {...(statusLabel === undefined ? {} : { statusLabel })}
          {...(action === undefined ? {} : { action })}
        />
        <p className="text-xs text-c-ink-3">
          {t('console.home.overview.hint-capacity', { threshold: thresholdPct })}
        </p>
        <span className="sr-only" role="status">
          {t('console.home.overview.a11y-capacity', {
            used: participants.used,
            limit: participants.included,
          })}
        </span>
      </CardBody>
    </Card>
  )
}

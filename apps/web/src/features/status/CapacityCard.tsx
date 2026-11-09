// "Capacité" (docs/specs/02-status.md §4.2): the gauge reads as people, not
// as a metric, and the upgrade prompt states what happens at the cap before
// offering a plan link — never a bare colour change (§2, condition 4). Every
// figure (`used`, `included`, `pct`, `threshold_pct`, `upgrade_prompt`) is
// server-computed; this component only picks which tier's copy to show.
//
// Two server signals, two different jobs (§4.2, §6): `threshold_pct`
// compared against `pct` drives the gauge's own colour tier — amber from the
// threshold, red at 100 %. `upgrade_prompt` is a separate flag ("not a
// threshold the console holds — is what turns the prompt on") and is what
// decides whether the message-and-buttons block below the gauge renders at
// all — the console never re-derives that decision from the percentage.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { trackCapacityCtaClicked, trackCapacityThresholdShown } from './analytics'
import { formatPercent } from '@/i18n/format'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody, CardHeader } from '@/ui/Card/Card'
import { Gauge } from '@/ui/Gauge/Gauge'
import { capacityTier, hasCapacityLimit } from './capacity'
import type { CapacityDimension } from './capacity'

export interface CapacityCardProps {
  participants: CapacityDimension
  thresholdPct: number
  upgradePrompt: boolean
  canOrder?: boolean
  onSeePlans: () => void
  onTalkToUs: () => void
}

export function CapacityCard({
  participants,
  thresholdPct,
  upgradePrompt,
  canOrder = false,
  onSeePlans,
  onTalkToUs,
}: CapacityCardProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const shown = hasCapacityLimit(participants)
  const tier = shown ? capacityTier(participants.pct, thresholdPct) : 'normal'
  const bucket: 'at-limit' | '95-100' | '90-95' =
    participants.pct >= 100 ? 'at-limit' : participants.pct >= 95 ? '95-100' : '90-95'

  useEffect(() => {
    if (shown && upgradePrompt) {
      trackCapacityThresholdShown(bucket)
    }
  }, [shown, upgradePrompt, bucket])

  // §8: a limit of 0 or missing hides the gauge entirely rather than
  // showing a false 0%.
  if (!shown) return null

  const statusLabel =
    tier === 'full'
      ? t('console.status.overview.error-capacity-reached', { limit: participants.included })
      : tier === 'warning'
        ? t('console.status.overview.status-capacity-near-limit')
        : undefined

  const handleSeePlans = () => {
    trackCapacityCtaClicked('plans')
    onSeePlans()
  }

  const handleTalkToUs = () => {
    trackCapacityCtaClicked('talk')
    onTalkToUs()
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-md font-semibold text-c-ink">
          {t('console.status.overview.title-capacity')}
        </h2>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <Gauge
          label={t('console.status.overview.title-capacity')}
          value={participants.used}
          max={participants.included}
          valueText={`${t('console.status.overview.status-capacity', {
            used: participants.used,
            limit: participants.included,
          })} ${formatPercent(participants.pct, locale)}`}
          {...(statusLabel === undefined ? {} : { statusLabel })}
        />
        {upgradePrompt && tier === 'warning' ? (
          <p className="text-sm text-c-ink-3">
            {t('console.status.overview.warning-capacity-near-limit', {
              limit: participants.included,
            })}
          </p>
        ) : null}
        {upgradePrompt ? (
          <div className="flex gap-3">
            {canOrder ? (
              <Button variant="secondary" size="sm" onClick={handleSeePlans}>
                {t('console.status.overview.action-see-plans')}
              </Button>
            ) : null}
            <Button variant="tertiary" size="sm" onClick={handleTalkToUs}>
              {t('console.status.overview.action-talk-to-us')}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

/** §8: `capacity: null` is a tenant not measured yet. The card says so and shows no figure. */
export function CapacityNotMeasured() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <h2 className="text-md font-semibold text-c-ink">
          {t('console.status.overview.title-capacity')}
        </h2>
      </CardHeader>
      <CardBody>
        <p className="text-sm text-c-ink-2">
          {t('console.status.overview.status-capacity-not-measured')}
        </p>
      </CardBody>
    </Card>
  )
}

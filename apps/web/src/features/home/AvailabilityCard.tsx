// docs/specs/08-home.md §6.5's first contract gap: the Core API has no field
// carrying a rolled-up 30-day availability percentage or the SLA commitment
// itself, so this card never renders one — "Mesure en cours", always, with a
// link to the Applications screen, the console's own status source. No
// external status page is linked (owner ruling 2026-09-24). §9: the same copy key covers "unavailable"
// and "not yet measurable"; the card does not distinguish them because
// nothing it could show would differ either way.

import { useTranslation } from 'react-i18next'
import { Card, CardBody } from '../../ui/Card/Card'
import { Link } from '@tanstack/react-router'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { trackCardLinkClicked } from './analytics'

export interface AvailabilityCardProps {
  org: string
}

export function AvailabilityCard({ org }: AvailabilityCardProps) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium text-c-ink-3">
          {t('console.home.overview.label-availability')}
        </p>
        <p className="text-sm text-c-ink">
          {t('console.home.overview.status-availability-measuring')}
        </p>
        <LinkButton variant="tertiary" size="sm" asChild>
          <Link
            to="/$org/status"
            params={{ org }}
            onClick={() => trackCardLinkClicked('availability')}
          >
            {t('console.home.overview.action-see-status')}
          </Link>
        </LinkButton>
      </CardBody>
    </Card>
  )
}

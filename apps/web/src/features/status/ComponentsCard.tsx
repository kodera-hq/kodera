// "État du service" (docs/specs/02-status.md §4.2). A separate fetch from
// the tenant status call (`useStatusComponents`, §6's own note that
// `/status/components` exists on its own), so it can fail on its own while
// the rest of the screen stays usable (§12 acceptance test 7): this card
// owns nothing but its own props — loading, data, error — and is driven
// entirely from outside so that split is visible at the call site.

import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody, CardHeader } from '@/ui/Card/Card'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { Skeleton } from '@/ui/Skeleton/Skeleton'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { componentNameKey, componentPillState, componentStateLabelKey } from './components'
import type { StatusComponent } from './components'

export interface ComponentsCardProps {
  components: readonly StatusComponent[] | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  /** Absent while the seven-day history is not offered (`src/app/capabilities.ts`): no link. */
  onOpenHistory?: (trigger: HTMLElement) => void
}

export function ComponentsCard({
  components,
  isLoading,
  isError,
  onRetry,
  onOpenHistory,
}: ComponentsCardProps) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader>
        <h2 className="text-md font-semibold text-c-ink">
          {t('console.status.overview.title-components')}
        </h2>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : isError ? (
          // No area-specific key exists for this card's own failure (unlike
          // the whole-screen `error-summary-unavailable`, which needs a
          // last-known timestamp this card does not carry) — the shared,
          // unconditional message covers a card-scoped fetch failure without
          // a placeholder to interpolate.
          <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
        ) : (
          <ul className="flex flex-col gap-2">
            {(components ?? []).map((component) => (
              <li key={component.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-c-ink">{t(componentNameKey(component.key))}</span>
                <StatusPill state={componentPillState(component.state)}>
                  {t(componentStateLabelKey(component.state))}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
        {isError ? (
          <div>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('console.common.action-retry')}
            </Button>
          </div>
        ) : onOpenHistory === undefined ? null : (
          <LinkButton
            href="#"
            variant="tertiary"
            size="sm"
            onClick={(event) => {
              event.preventDefault()
              onOpenHistory(event.currentTarget)
            }}
          >
            {t('console.status.overview.action-history')}
          </LinkButton>
        )}
      </CardBody>
    </Card>
  )
}

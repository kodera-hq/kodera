// Home supplies role-aware preparation and support under its provisioning timeline.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardBody } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { ProgressList } from '../../ui/ProgressList/ProgressList'
import type { ProgressStepStatus } from '../../ui/ProgressList/ProgressList'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { cx } from '../../ui/cx'
import { LINK_TEXT } from '../../ui/linkText'
import type { ProvisioningStepInput, ProvisioningStepLabel } from './provisioning-steps'
import { toProgressSteps } from './provisioning-steps'
import { PAGE_TITLE } from '../../ui/pageTitle'

export interface ProvisioningViewProps {
  /** `undefined` while the first fetch has not resolved — renders the
   * `Skeleton` timeline (state matrix "Loading"). */
  steps: readonly ProvisioningStepInput[] | undefined
  /** The state matrix's "Progress fetch fails → last known progress,
   * 'Impossible d'actualiser', retry": true once refreshing (not the first
   * load) has failed, so `steps` still holds the last known progress. */
  refreshFailed?: boolean
  onRetry?: () => void
  /** The caller's support action, under the timeline. */
  support: ReactNode
  /** The caller gates preparation with the current membership role. */
  preparation?: ReactNode
}

const STEP_ORDER: ProvisioningStepLabel[] = [
  'order',
  'server',
  'apps',
  'addresses',
  'accounts',
  'backups',
]

export function ProvisioningView({
  steps,
  refreshFailed = false,
  onRetry,
  support,
  preparation,
}: ProvisioningViewProps) {
  const { t } = useTranslation()

  const stepLabels: Record<ProvisioningStepLabel, string> = {
    order: t('console.status.overview.status-step-order'),
    server: t('console.status.overview.status-step-server'),
    apps: t('console.status.overview.status-step-apps'),
    addresses: t('console.status.overview.status-step-addresses'),
    accounts: t('console.status.overview.status-step-accounts'),
    backups: t('console.status.overview.status-step-backups'),
  }

  const statusLabels: Record<ProgressStepStatus, string> = {
    pending: t('console.status.overview.status-pending'),
    running: t('console.status.overview.status-running'),
    done: t('console.status.overview.status-done'),
    failed: t('console.status.overview.status-failed'),
    skipped: t('console.status.overview.status-skipped'),
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className={PAGE_TITLE}>{t('console.status.overview.title-provisioning')}</h1>
        <p role="status" className="mt-1 text-md text-c-ink-3">
          {t('console.status.overview.subtitle-provisioning')}
        </p>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-4">
          {refreshFailed ? (
            <div className="flex items-center gap-3">
              <InlineAlert kind="warning">{t('console.common.error-unavailable')}</InlineAlert>
              {onRetry === undefined ? null : (
                <button
                  type="button"
                  onClick={onRetry}
                  className={cx('text-sm font-semibold', LINK_TEXT.standalone)}
                >
                  {t('console.common.action-retry')}
                </button>
              )}
            </div>
          ) : null}
          {steps === undefined ? (
            <Skeleton label={t('console.common.a11y-loading')} className="h-[192px]" />
          ) : (
            <ProgressList
              steps={toProgressSteps(
                STEP_ORDER.map(
                  (key): ProvisioningStepInput =>
                    steps.find((step) => step.customer_label_key === key) ?? {
                      customer_label_key: key,
                      status: 'pending',
                    }
                ),
                stepLabels,
                t('console.status.overview.error-step-failed')
              )}
              statusLabels={statusLabels}
            />
          )}
        </CardBody>
      </Card>

      {preparation}
      {support}
    </div>
  )
}

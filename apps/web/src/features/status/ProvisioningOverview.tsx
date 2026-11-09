// The provisioning timeline (docs/specs/02-status.md §4.1). It also renders supplied last-operation diagnostics without an
// installation promise. Props keep this presentation independent of the
// status screen’s routing and queries.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { trackProvisioningStepSeen } from './analytics'
import type { MessageKey } from '@/i18n'
import { Button } from '@/ui/Button/Button'
import { ProgressList } from '@/ui/ProgressList/ProgressList'
import type { ProgressListStep } from '@/ui/ProgressList/ProgressList'
import { customerSteps, failedStep, justCompletedIndex, runningStepIndex } from './steps'
import type { CustomerStep, ProvisioningStep, ProvisioningStepLabel } from './steps'

const STEP_LABEL_KEY: Record<ProvisioningStepLabel, MessageKey> = {
  order: 'console.status.overview.status-step-order',
  server: 'console.status.overview.status-step-server',
  apps: 'console.status.overview.status-step-apps',
  addresses: 'console.status.overview.status-step-addresses',
  accounts: 'console.status.overview.status-step-accounts',
  backups: 'console.status.overview.status-step-backups',
}

export interface ProvisioningSupportContext {
  reason: 'late' | 'step-failed'
  jobId: string | undefined
}

export interface ProvisioningOverviewProps {
  steps: readonly ProvisioningStep[]
  /**
   * True once `agent.stale` — the contract carries no `estimated_ready_at`
   * or per-step expected-duration field (checked against
   * `TenantStatusView` and `ProvisioningStep`), so "this is taking longer
   * than expected" is read from the same missed-heartbeat signal the
   * screen already uses for a live tenant's staleness, not a client-side
   * timer computed against an invented threshold.
   */
  late: boolean
  diagnostic?: boolean
  onSupport: (context: ProvisioningSupportContext) => void
}

function elapsedBucket(startedAt: string | undefined): '<1h' | '1-4h' | '4-24h' | '>24h' {
  if (startedAt === undefined) return '<1h'
  const hours = (Date.now() - new Date(startedAt).getTime()) / 3_600_000
  if (hours < 1) return '<1h'
  if (hours < 4) return '1-4h'
  if (hours < 24) return '4-24h'
  return '>24h'
}

export function ProvisioningOverview({
  steps,
  late,
  diagnostic = false,
  onSupport,
}: ProvisioningOverviewProps) {
  const { t } = useTranslation()
  const customer = customerSteps(steps)
  const running = runningStepIndex(customer)
  const failed = failedStep(customer)

  const [announcement, setAnnouncement] = useState('')
  const previousRef = useRef<CustomerStep[] | undefined>(undefined)
  const seenRunningRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const justCompleted = justCompletedIndex(previousRef.current, customer)
    if (justCompleted !== undefined) {
      const completedStep = customer[justCompleted]
      if (completedStep !== undefined) {
        setAnnouncement(
          t('console.status.overview.a11y-progress', {
            index: justCompleted + 1,
            total: customer.length,
            step: t(STEP_LABEL_KEY[completedStep.label]),
          })
        )
      }
    }
    previousRef.current = customer
    // Analytics: fire once per newly-seen running step, never on a poll that
    // leaves the running step unchanged.
    if (running !== undefined && seenRunningRef.current !== running) {
      seenRunningRef.current = running
      trackProvisioningStepSeen(running, elapsedBucket(customer[0]?.startedAt))
    }
    // `customer` is a fresh array every render (`customerSteps` returns a
    // new one); comparing its serialised steps is what keeps this effect
    // from re-running on an unrelated render with the same data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(customer), running])

  const progressSteps: ProgressListStep[] = customer.map((step) => ({
    id: step.label,
    label: t(STEP_LABEL_KEY[step.label]),
    status: step.status,
    ...(step.status === 'failed'
      ? { message: t('console.status.overview.error-step-failed') }
      : {}),
  }))

  const supportContext: ProvisioningSupportContext =
    failed !== undefined
      ? { reason: 'step-failed', jobId: failed.jobId }
      : { reason: 'late', jobId: undefined }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-c-ink-3" role={late ? 'status' : undefined}>
        {diagnostic
          ? t('console.status.overview.state-last-operation')
          : late
            ? t('console.status.overview.error-provisioning-late')
            : t('console.status.overview.subtitle-provisioning')}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ProgressList
        steps={progressSteps}
        statusLabels={{
          pending: t('console.status.overview.status-pending'),
          running: t('console.status.overview.status-running'),
          done: t('console.status.overview.status-done'),
          failed: t('console.status.overview.status-failed'),
          skipped: t('console.status.overview.status-skipped'),
        }}
      />
      {failed !== undefined || late ? (
        <div>
          <Button variant="secondary" onClick={() => onSupport(supportContext)}>
            {t('console.common.action-contact-support')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

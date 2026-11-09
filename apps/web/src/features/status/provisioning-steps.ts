// Maps the Core API's `ProvisioningStep[]` (contract statuses: pending,
// running, succeeded, failed, skipped) onto `ProgressList`'s own vocabulary
// (pending, running, done, failed, skipped — docs/dev's ui-common.md primitive)
// and attaches the fixed, catalogue-driven failure message on a failed step
// rather than the API's own `detail`, which is staff-facing English
// (docs/dev/I18N.md: never render `detail` raw to a customer).
//
// Pure and side-effect-free so both `02-status.md` and `08-home.md`'s
// provisioning views — and this module's own test — can exercise the mapping
// without mounting anything.

import type { components } from '../../api/schema'
import type { ProgressListStep, ProgressStepStatus } from '../../ui/ProgressList/ProgressList'

export type ApiProvisioningStep = components['schemas']['ProvisioningStep']
export type ProvisioningStepLabel = components['schemas']['ProvisioningStepLabel']

/** Only the fields the mapping reads — a synthetic "not started yet" filler
 * row (`ProvisioningView`, for a customer step the job has not reported at
 * all) can satisfy this without inventing the rest of `ApiProvisioningStep`. */
export type ProvisioningStepInput = Pick<ApiProvisioningStep, 'customer_label_key' | 'status'>

const STATUS_MAP: Record<ApiProvisioningStep['status'], ProgressStepStatus> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

/**
 * `stepLabels` and `failedMessage` come from the caller's own `useTranslation()`
 * — this module holds no customer-readable string of its own.
 */
export function toProgressSteps(
  steps: readonly ProvisioningStepInput[],
  stepLabels: Record<ProvisioningStepLabel, string>,
  failedMessage: string
): ProgressListStep[] {
  return steps.map((step) => {
    const base = {
      id: step.customer_label_key,
      label: stepLabels[step.customer_label_key],
      status: STATUS_MAP[step.status],
    }
    return step.status === 'failed' ? { ...base, message: failedMessage } : base
  })
}

// Maps the job's internal `ProvisioningStep[]` onto the fixed, customer-facing
// six-step sequence (docs/specs/02-status.md §4.1, §6): the console never
// renders `ProvisioningStep.key` (an OpenTofu apply, an Ansible role — staff
// vocabulary that changes when the deployment profile changes), only
// `customer_label_key`, a closed enum of six values the schema documents as
// "a customer is shown six, always the same six, in this order."

import type { components } from '@/api/schema'
import type { ProgressStepStatus } from '@/ui/ProgressList/ProgressList'

export type ProvisioningStep = components['schemas']['ProvisioningStep']
export type ProvisioningStepLabel = components['schemas']['ProvisioningStepLabel']

/** The fixed order — always these six, always in this order, whatever the
 * job behind them actually ran. */
export const CUSTOMER_STEP_ORDER: readonly ProvisioningStepLabel[] = [
  'order',
  'server',
  'apps',
  'addresses',
  'accounts',
  'backups',
]

export interface CustomerStep {
  label: ProvisioningStepLabel
  status: ProgressStepStatus
  startedAt: string | undefined
  endedAt: string | undefined
  jobId: string | undefined
}

const STATUS: Record<ProvisioningStep['status'], ProgressStepStatus> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

/** When more than one internal step rolls into the same customer step, the
 * customer step reads as its worst-known state — a failure anywhere behind a
 * label is not hidden by another internal step that happened to succeed. */
const SEVERITY: Record<ProgressStepStatus, number> = {
  failed: 4,
  running: 3,
  pending: 2,
  skipped: 1,
  done: 0,
}

/**
 * Always returns exactly six entries, in `CUSTOMER_STEP_ORDER`. A customer
 * label with no matching internal step yet (the job has not reached it) is
 * `pending`; a job step whose `customer_label_key` is not one of the six is
 * impossible by the schema's own closed enum, so nothing here has a branch
 * for it — a step the console does not recognise cannot exist on the wire.
 */
export function customerSteps(steps: readonly ProvisioningStep[]): CustomerStep[] {
  return CUSTOMER_STEP_ORDER.map((label) => {
    let worst: CustomerStep | undefined
    for (const step of steps) {
      if (step.customer_label_key !== label) continue
      const status = STATUS[step.status]
      if (worst === undefined || SEVERITY[status] > SEVERITY[worst.status]) {
        worst = {
          label,
          status,
          startedAt: step.started_at ?? undefined,
          endedAt: step.ended_at ?? undefined,
          jobId: step.job_id ?? undefined,
        }
      }
    }
    return (
      worst ?? {
        label,
        status: 'pending',
        startedAt: undefined,
        endedAt: undefined,
        jobId: undefined,
      }
    )
  })
}

/** The 0-based index of the running step, or `undefined` when none is
 * running — the ARIA announcement ("Étape 3 sur 6…") and the
 * `status_provisioning_step_seen` analytics event both key off this. */
export function runningStepIndex(steps: readonly CustomerStep[]): number | undefined {
  const index = steps.findIndex((step) => step.status === 'running')
  return index === -1 ? undefined : index
}

/** The first `failed` step, if any — carries the `job_id` a support ticket
 * needs (§12 acceptance test 6). */
export function failedStep(steps: readonly CustomerStep[]): CustomerStep | undefined {
  return steps.find((step) => step.status === 'failed')
}

/**
 * The index of the step that just transitioned to `done`, comparing this
 * poll's steps against the previous one — or `undefined` when nothing
 * newly completed. §10: "Step transitions are announced once, politely
 * […] Polling that changes nothing announces nothing." `previous ===
 * undefined` (the very first render) never counts as a transition: there is
 * nothing to compare against yet, so nothing to announce.
 */
export function justCompletedIndex(
  previous: readonly CustomerStep[] | undefined,
  current: readonly CustomerStep[]
): number | undefined {
  if (previous === undefined) return undefined
  for (let index = 0; index < current.length; index++) {
    const before = previous[index]
    const after = current[index]
    if (after?.status === 'done' && before?.status !== 'done') return index
  }
  return undefined
}

import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'
import { InlineAlert } from '../InlineAlert/InlineAlert'
import { Spinner } from '../Spinner/Spinner'

export type ProgressStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ProgressListStep {
  id: string
  label: string
  status: ProgressStepStatus
  /** Shown under a `running` step — the caller's own interpolated string,
   * e.g. "en cours · sous 10 minutes". Omit it and the step shows only its
   * label, which a list with no ETA at all still renders cleanly. */
  caption?: string
  /** Right-aligned, e.g. "31 mars 2027" — omitted per step, not just for the
   * whole list, so a dunning ladder whose dates are not yet known can mix
   * dated and undated rows without leaving a gap where a date would be. */
  timestamp?: string
  /** Shown under a `failed` step, as an `InlineAlert` — the reason, from the
   * caller's message catalogue. */
  message?: string
}

export interface ProgressListProps extends ComponentPropsWithoutRef<'ol'> {
  steps: ProgressListStep[]
  /**
   * The word half of "word + colour" (`ui-common.md`) for each of the five
   * states, read next to the step's own label rather than left to the icon's
   * shape and colour alone. From the caller's message catalogue — a
   * primitive holds no status vocabulary of its own, the same contract
   * `StatusPill` keeps.
   */
  statusLabels: Record<ProgressStepStatus, string>
}

/**
 * COMPONENTS.md's "Provisioning timeline" covers `pending`/`running`/`done`;
 * `failed` and `skipped` are two of the three design gaps
 * (`docs/specs/README.md`) this primitive answers, alongside a step with no
 * `timestamp` at all — the dunning ladder's own "generic ladder without
 * dates" state. Always vertical: the two screens this primitive serves
 * (provisioning, dunning) both read top to bottom, unlike `Stepper`'s
 * horizontal default for a handful of screen names.
 *
 * No keyboard map: a status display, not a set of controls, the same
 * contract `Stepper` keeps.
 */
const CIRCLE: Record<Exclude<ProgressStepStatus, 'running'>, string> = {
  pending: 'border border-c-border-strong bg-c-surface text-c-ink-3',
  done: 'bg-c-ok text-c-surface',
  failed: 'bg-c-bad text-c-on-inverse',
  skipped: 'border border-dashed border-c-border-strong bg-c-surface text-c-ink-3',
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2 5 8.7l4.5-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function SkippedIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      <path d="M3 6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function Circle({ status }: { status: ProgressStepStatus }) {
  if (status === 'running') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-c-accent-ink bg-c-surface">
        <Spinner size="sm" className="text-c-accent-ink" />
      </span>
    )
  }

  return (
    <span
      className={cx(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
        CIRCLE[status]
      )}
    >
      {status === 'done' ? <CheckIcon /> : null}
      {status === 'failed' ? <CrossIcon /> : null}
      {status === 'skipped' ? <SkippedIcon /> : null}
    </span>
  )
}

export const ProgressList = forwardRef<HTMLOListElement, ProgressListProps>(function ProgressList(
  { steps, statusLabels, className, ...rest },
  ref
) {
  return (
    <ol ref={ref} {...rest} className={cx('flex flex-col', className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1
        // The connector below a step reads as "done" only when the step
        // itself completed — a running or failed step's own connector stays
        // the neutral colour, since nothing after it has happened yet.
        const connectorDone = step.status === 'done'

        return (
          <li
            key={step.id}
            aria-current={step.status === 'running' ? 'step' : undefined}
            className="flex gap-3"
          >
            <div className="flex flex-col items-center">
              <Circle status={step.status} />
              {isLast ? null : (
                <span
                  aria-hidden="true"
                  className={cx('w-px flex-1', connectorDone ? 'bg-c-ok' : 'bg-c-border')}
                />
              )}
            </div>
            <div className={cx('flex flex-col gap-1', isLast ? 'pb-0' : 'pb-4')}>
              <div className="flex items-baseline gap-3">
                <span
                  className={cx(
                    'text-sm',
                    step.status === 'skipped' ? 'text-c-ink-3' : 'font-medium text-c-ink'
                  )}
                >
                  {step.label}
                </span>
                <span className="text-xs text-c-ink-3">{statusLabels[step.status]}</span>
                {step.timestamp === undefined ? null : (
                  <span className="font-mono text-xs text-c-ink-3">{step.timestamp}</span>
                )}
              </div>
              {step.status === 'running' && step.caption !== undefined ? (
                <p className="text-xs font-medium text-c-accent-ink">{step.caption}</p>
              ) : null}
              {step.status === 'failed' && step.message !== undefined ? (
                <InlineAlert kind="error">{step.message}</InlineAlert>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
})

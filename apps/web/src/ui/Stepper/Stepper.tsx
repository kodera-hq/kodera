import { cx } from '../cx'

export type StepStatus = 'done' | 'current' | 'upcoming'
export type StepperOrientation = 'horizontal' | 'vertical'

export interface StepperStep {
  label: string
  status: StepStatus
}

export interface StepperProps {
  steps: StepperStep[]
  orientation?: StepperOrientation
}

/**
 * COMPONENTS.md: "Circle 22–24: done cobalt.500 with ✓, current cobalt.500
 * with number, upcoming 1.5 px slate.300 border." No 1.5 px step exists in
 * the tokens package (borders are 0/1/2/4/8), so the upcoming ring is drawn
 * at the nearest one, `border` (1 px) — the same move `Button`'s destructive
 * border makes for a value the palette does not publish.
 */
const CIRCLE: Record<StepStatus, string> = {
  done: 'bg-c-action text-c-on-inverse',
  current: 'bg-c-action text-c-on-inverse',
  upcoming: 'border border-c-border-strong bg-c-surface text-c-ink-3',
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

/**
 * `aria-current="step"` on the current step's `li`, the ARIA token written
 * for exactly this: a step in a multi-step process. No keyboard behaviour of
 * its own — a stepper here is a status display, not a set of controls; a
 * screen that lets someone jump to a step composes its own buttons around
 * this primitive.
 */
export function Stepper({ steps, orientation = 'horizontal' }: StepperProps) {
  const vertical = orientation === 'vertical'

  return (
    <ol className={cx('flex', vertical ? 'flex-col' : 'items-center')}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1
        const connectorDone = step.status === 'done'

        return (
          <li
            key={step.label}
            aria-current={step.status === 'current' ? 'step' : undefined}
            className={cx('flex', vertical ? 'flex-col' : 'flex-1 items-center')}
          >
            <div
              className={cx('flex items-center', vertical ? 'flex-row gap-3' : 'flex-col gap-2')}
            >
              <span
                className={cx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  CIRCLE[step.status]
                )}
              >
                {step.status === 'done' ? <CheckIcon /> : index + 1}
              </span>
              <span
                className={cx(
                  'text-sm whitespace-nowrap',
                  step.status === 'current' ? 'font-semibold text-c-ink' : 'text-c-ink-3'
                )}
              >
                {step.label}
              </span>
            </div>
            {isLast ? null : (
              <span
                aria-hidden="true"
                className={cx(
                  vertical ? 'ml-3 h-4 w-px' : 'mx-2 h-px flex-1',
                  connectorDone ? 'bg-c-action' : 'bg-c-border'
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

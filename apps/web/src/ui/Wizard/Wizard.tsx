import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cx } from '../cx'
import { Stepper } from '../Stepper/Stepper'
import type { StepStatus } from '../Stepper/Stepper'

export interface WizardStep {
  id: string
  label: string
  content: ReactNode
}

export interface WizardProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  steps: WizardStep[]
  /**
   * Controlled, always — the same contract `Tabs.value` keeps and for the
   * same reason: a screen keeps the current step in the URL (`?step=`) as
   * the single source of truth and passes it straight through, so the URL
   * and the visible panel cannot disagree the moment someone uses the back
   * button.
   */
  step: string
  /** Accessible name for the `Stepper` header, e.g. "Étapes de la
   * commande". */
  stepperLabel: string
  /**
   * What a screen reader hears each time `step` changes, in an
   * `aria-live="polite"` region — the caller's own interpolated string,
   * e.g. "Étape 2 sur 4 : Contacts". It is the one announcement of a step
   * change. The wizard itself moves no focus: it cannot tell a step that
   * replaces the screen from one that only swaps a panel. Where each step is a
   * route, as in the order, the route change puts focus on the step's visible
   * title and announces nothing of its own for a step
   * (docs/specs/00-shell-and-login.md §10, docs/specs/01-order.md §10).
   */
  announcement: string
  /** Usually a `Button` with `variant="secondary"`. Omitted on the first
   * step. */
  back?: ReactNode
  /** Usually a `Button` — the step's own submit or "Continuer" action. */
  next?: ReactNode
}

/**
 * Keyboard: `Tab` reaches whatever the active panel and `back`/`next` put in
 * the tab order — the wizard shell itself adds no control and takes none
 * away. The header `Stepper` is a status display, not a set of tabs: it
 * shows where the person is, it does not let them jump ahead.
 */
export const Wizard = forwardRef<HTMLDivElement, WizardProps>(function Wizard(
  { steps, step, stepperLabel, announcement, back, next, className, ...rest },
  ref
) {
  const currentIndex = steps.findIndex((candidate) => candidate.id === step)
  const active = currentIndex === -1 ? undefined : steps[currentIndex]

  const stepperSteps = steps.map((candidate, index) => {
    const status: StepStatus =
      currentIndex === -1
        ? 'upcoming'
        : index < currentIndex
          ? 'done'
          : index === currentIndex
            ? 'current'
            : 'upcoming'
    return { label: candidate.label, status }
  })

  return (
    <div ref={ref} {...rest} className={cx('flex flex-col gap-6', className)}>
      <nav aria-label={stepperLabel}>
        <Stepper steps={stepperSteps} />
      </nav>
      {/* The one announcement of a step change. Focus is the caller's to move:
       * in the order it goes to the new step's title, not to this region. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div>{active?.content}</div>
      {back === undefined && next === undefined ? null : (
        <div className="flex justify-between gap-3">
          <div>{back}</div>
          <div>{next}</div>
        </div>
      )}
    </div>
  )
})

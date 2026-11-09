import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'

export type StatusPillState = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'planned'

/**
 * Text is the `-600` step on the `-100` tint everywhere (DESIGN_SYSTEM.md §2:
 * "Text uses the -600 step on the -100 tint; the -500 step is for dots and
 * fills only" — never `-500` as running text on white). COMPONENTS.md's own
 * status-pill table still shows `cobalt.500` for the info row; that table
 * predates the accessibility rule two sections above it in the same document,
 * and the rule is what a token test would hold this to if cobalt had a
 * contrast pair recorded for it. `planned` has no fill and no dot: a dashed
 * border stands in for both, which is why it is spelled out below rather than
 * folded into this map.
 */
const FILLED: Record<Exclude<StatusPillState, 'planned'>, { pill: string; dot: string }> = {
  success: { pill: 'bg-c-ok-soft text-c-ok-ink', dot: 'bg-c-ok' },
  info: { pill: 'bg-c-accent-soft text-c-accent-ink', dot: 'bg-c-action' },
  warning: { pill: 'bg-c-warn-soft text-c-warn-ink', dot: 'bg-c-warn' },
  danger: { pill: 'bg-c-bad-soft text-c-bad-ink', dot: 'bg-c-bad' },
  neutral: { pill: 'bg-c-muted text-c-ink-2', dot: 'bg-c-ink-4' },
}

export interface StatusPillProps extends ComponentPropsWithoutRef<'span'> {
  state: StatusPillState
}

/**
 * Word and colour together, never colour alone (AGENTS.md, DESIGN_SYSTEM.md
 * §2). The word is the caller's `children`, from the message catalogue — this
 * primitive holds no status vocabulary of its own, only the six palettes.
 *
 * Not a live region: a table full of pills changing state under a websocket
 * update is not a stream of interruptions to announce one row at a time. A
 * screen using this to report a state change worth announcing wires its own
 * `aria-live` region around the update, at the scope where that is true.
 */
export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(
  { state, className, children, ...rest },
  ref
) {
  // COMPONENTS.md gives this pill 5×11 px padding and a 6 px dot, none of
  // which are on the tokens package's 4 px grid (docs/dev/TESTING.md §4 and
  // `src/ui/README.md`: only `h-1`…`h-12` at the preset's own steps, never an
  // arbitrary value). The nearest steps the grid actually has stand in until
  // the tokens package publishes ones that match the spec exactly.
  const base = cx(
    'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1',
    'text-sm font-medium'
  )

  if (state === 'planned') {
    return (
      <span
        ref={ref}
        className={cx(base, 'border border-dashed border-c-border-strong text-c-ink-2', className)}
        {...rest}
      >
        {children}
      </span>
    )
  }

  const palette = FILLED[state]

  return (
    <span ref={ref} className={cx(base, palette.pill, className)} {...rest}>
      <span data-pill-dot aria-hidden="true" className={cx('h-2 w-2 rounded-full', palette.dot)} />
      {children}
    </span>
  )
})

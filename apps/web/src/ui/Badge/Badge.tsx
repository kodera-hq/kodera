import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'

export type BadgeVariant = 'neutral' | 'accent'

/** Fill only — a badge carries a count or a short label, never a status word
 * that needs its own colour vocabulary. That is `StatusPill`. */
const VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-c-muted text-c-ink-2',
  accent: 'bg-c-accent-soft text-c-accent-ink',
}

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  variant?: BadgeVariant
}

/**
 * A count or a short label riding beside something else — a nav item, a tab,
 * a table header. Not interactive and not a keyboard target on its own; when
 * it sits inside a control (a tab, a button), that control carries the name
 * and Badge stays presentational content inside it.
 *
 * One line is 20 px tall, the `min-h-5` floor around a 15 px line. A label
 * longer than the space it is given wraps onto a second line and the pill
 * grows with it; a fixed height let the extra lines spill out of the pill.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', className, children, ...rest },
  ref
) {
  return (
    <span
      ref={ref}
      className={cx(
        'inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-2 py-[2px]',
        'text-center text-xs leading-snug font-medium',
        VARIANT[variant],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
})

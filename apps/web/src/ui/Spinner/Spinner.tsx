import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const SIZE: Record<SpinnerSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
}

export interface SpinnerProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  /**
   * What a screen reader announces while this spinner is on screen, from the
   * caller's message catalogue — a primitive never holds a string a customer
   * reads. With a label the spinner is a live `status`; without one it is
   * decorative and hidden from assistive technology.
   *
   * Omit it only where the surrounding control already announces the wait.
   * `Button` does: it keeps its own label in the accessibility tree and sets
   * `aria-busy`, so a labelled spinner inside it would announce the same wait
   * twice, in two different words.
   */
  label?: string
  size?: SpinnerSize
}

/**
 * The one thing in the console that is allowed to spin. Skeleton blocks, not a
 * spinner, are what a loading card shows (COMPONENTS.md); this is for a wait
 * that lives inside a control.
 *
 * It inherits its colour from `currentColor`, so it is legible on whatever the
 * control it sits in has already established, and it stops moving under
 * `prefers-reduced-motion` because `src/index.css` collapses every animation.
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { label, size = 'md', className, ...rest },
  ref
) {
  const decorative = label === undefined

  return (
    <span
      ref={ref}
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative ? true : undefined}
      className={cx('inline-flex items-center justify-center', className)}
      {...rest}
    >
      <span
        className={cx(
          'animate-spin rounded-full border-2 border-current border-t-transparent',
          SIZE[size]
        )}
      />
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  )
})

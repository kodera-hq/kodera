import { forwardRef, useId } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'

export type SkeletonShape = 'block' | 'text' | 'circle'

/** The ground the skeleton sits on: `inverse` inside a `Card tone="inverse"`. */
export type SkeletonTone = 'default' | 'inverse'

/**
 * Height only — width defaults to filling the container (`w-full`), so a
 * caller sizes a skeleton by wrapping it, never by fighting `cx`'s
 * append-only merge (`src/ui/cx.ts`) with a conflicting `w-*` class.
 */
const SHAPE: Record<SkeletonShape, string> = {
  block: 'h-4 w-full rounded-sm',
  text: 'h-3 w-full rounded-sm',
  circle: 'h-8 w-8 rounded-full',
}

/**
 * The block's colour is chosen here, never by a caller's `bg-*` class. With a
 * `label`, `className` lands on the status wrapper and the block keeps its own
 * colour; without one, `cx` does not merge (`src/ui/cx.ts`), so two
 * backgrounds are decided by stylesheet order. Either way a caller's `bg-*`
 * left the pale default block showing on the inverse cards.
 */
const TONE: Record<SkeletonTone, string> = {
  default: 'bg-c-muted-2',
  inverse: 'bg-c-inverse-2',
}

export interface SkeletonProps extends ComponentPropsWithoutRef<'span'> {
  shape?: SkeletonShape
  tone?: SkeletonTone
  /**
   * What a screen reader announces while this block stands in for content,
   * from the caller's message catalogue — a primitive never holds a string a
   * customer reads. Without it the block is purely decorative: a card that
   * already announces its own loading state (a heading, a live region higher
   * up) does not need every one of its skeleton blocks announcing again.
   */
  label?: string
}

/**
 * Blocks, never a spinner, on a card mid-load (COMPONENTS.md: "Loading:
 * skeleton blocks slate.100 — never a spinner on a card"). `animate-pulse`
 * is the one motion a skeleton carries, and `src/index.css` collapses it to a
 * single near-instant frame under `prefers-reduced-motion`.
 */
export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(function Skeleton(
  { shape = 'block', tone = 'default', label, className, ...rest },
  ref
) {
  const labelId = useId()

  if (label === undefined) {
    return (
      // `{...rest}` first, the guarantee after: a caller passing its own
      // `aria-hidden` through the props this primitive forwards must not be
      // able to un-hide a decorative block by accident.
      <span
        ref={ref}
        {...rest}
        aria-hidden="true"
        className={cx('block animate-pulse', TONE[tone], SHAPE[shape], className)}
      />
    )
  }

  return (
    <span
      ref={ref}
      {...rest}
      role="status"
      // `role="status"` is not named from its content on its own — an
      // explicit `aria-labelledby` is what makes the sr-only text below the
      // region's accessible name rather than an unreachable text node. Both
      // set after `{...rest}` so a caller-supplied `role`/`aria-labelledby`
      // cannot silence the announcement this primitive exists to make.
      aria-labelledby={labelId}
      className={cx('inline-block', className)}
    >
      <span aria-hidden="true" className={cx('block animate-pulse', TONE[tone], SHAPE[shape])} />
      <span id={labelId} className="sr-only">
        {label}
      </span>
    </span>
  )
})

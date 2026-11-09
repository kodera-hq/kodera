import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cx } from '../cx'

export interface EmptyStateProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  /** Decoration only, hidden from assistive technology — the title carries
   * the meaning. COMPONENTS.md: a 48 px tile on the cobalt-100 tint. */
  icon?: ReactNode
  /** A heading, not a paragraph, so a screen reader can jump straight to an
   * empty section the way it jumps to any other heading. */
  title: string
  /** Match the surrounding outline: h1 for a page, h2 below it; default h3 stays unchanged. */
  headingLevel?: 1 | 2 | 3
  /** One short sentence, not a paragraph (COMPONENTS.md) — the stories show
   * the length this settles to in practice, longer than COMPONENTS.md's own
   * terse example. */
  body: string
  /** One primary CTA, never a row of choices — COMPONENTS.md is explicit that
   * an empty state offers exactly one action. */
  action?: ReactNode
}

/**
 * No keyboard map of its own: the only interactive thing here is the caller's
 * `action`, which carries its own.
 *
 * Centred, COMPONENTS.md's tile-title-body-action stack. Loading uses
 * `Skeleton` blocks instead, never this — an empty state that says nothing is
 * missing is a different message from one still fetching.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, headingLevel = 3, body, action, className, ...rest },
  ref
) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3'
  return (
    <div
      ref={ref}
      className={cx('flex flex-col items-center gap-3 py-12 text-center', className)}
      {...rest}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-c-accent-soft text-c-accent-ink"
        >
          {icon}
        </span>
      )}
      <Heading className="text-lg font-semibold text-c-ink">{title}</Heading>
      {/* 320 px, Tailwind's own `xs` max-width step converted to a bracket
       * value so the spacing guard can judge it — a line-length measure, not
       * a spacing step, and not in COMPONENTS.md yet. */}
      <p className="max-w-[320px] text-sm text-c-ink-3">{body}</p>
      {action === undefined ? null : <div className="mt-1">{action}</div>}
    </div>
  )
})

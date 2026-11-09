import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cx } from '../cx'

export type CardTone = 'default' | 'inverse'

/** The default tone's edge: `action` for a recommended card, `accent` for a
 * chosen one (see `PlanCard`). */
export type CardEdge = 'default' | 'action' | 'accent'

/**
 * COMPONENTS.md: "White, border slate.200, radius lg (12), padding 20–24,
 * shadow card. Inverse card (contract/support): slate.900 bg, white text,
 * slate.400 secondary." The tokens package has no `slate-400` step (v0.1
 * carries 100/150/200/300/500/600/700/900), so secondary text on the inverse
 * ground is expressed as `white` at reduced opacity rather than a colour the
 * palette does not publish — a modifier on a real token, not a value typed in
 * here, the same move `Button`'s destructive border makes.
 */
const TONE: Record<CardTone, string> = {
  default: 'bg-c-surface text-c-ink',
  // `focus-ground-inverse` (`src/index.css`): a control inside draws the
  // on-inverse ring, and a button box's offset gap is this ground.
  // `inverse-edge` (`src/index.css`): a 1 px `c-border` edge in dark and black
  // only, where the inverse ground is the page's own or nearly.
  inverse: 'focus-ground-inverse inverse-edge bg-c-inverse text-c-on-inverse',
}

/**
 * One edge per card, chosen here. A caller's own role border beside the default
 * `border-c-border` is decided by stylesheet order (`cx` does not merge), and
 * `border-c-border` comes later: `PlanCard`'s recommended `border-c-action`
 * painted grey. The inverse tone takes no `edge`: its only edge is
 * `inverse-edge`, drawn by the theme (dark and black), never in light.
 */
const EDGE: Record<CardEdge, string> = {
  default: 'border border-c-border',
  action: 'border-2 border-c-action',
  accent: 'border-2 border-c-accent-ink',
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone
  edge?: CardEdge
}

/**
 * The base surface every data-display primitive in this unit floats on. No
 * padding of its own — `CardHeader`, `CardBody` and `CardFooter` carry it, so
 * a caller composing only a body is not fighting a padding it did not ask for.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { tone = 'default', edge = 'default', className, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cx(
        'card-flat-dark rounded-lg shadow-card shadow-c-shadow-1',
        TONE[tone],
        tone === 'default' && EDGE[edge],
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
})

/**
 * Header/footer borders are drawn for the default (light) tone. A card that
 * composes these slots on `tone="inverse"` is not a shape this unit's callers
 * need yet — `MetricCard` renders its inverse tone straight into `CardBody`
 * — so the border is not made tone-aware until something needs it to be.
 */
export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cx(
          'flex items-start justify-between gap-4 border-b border-c-border-soft px-5 py-4',
          className
        )}
        {...rest}
      />
    )
  }
)

export const CardBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardBody({ className, ...rest }, ref) {
    return <div ref={ref} className={cx('p-5', className)} {...rest} />
  }
)

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cx(
          'flex items-center justify-end gap-3 border-t border-c-border-soft px-5 py-4',
          className
        )}
        {...rest}
      />
    )
  }
)

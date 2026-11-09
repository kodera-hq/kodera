import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { Card, CardBody } from '../Card/Card'
import type { CardTone } from '../Card/Card'
import { cx } from '../cx'

export type MetricDeltaDirection = 'up' | 'down' | 'neutral'

/**
 * Word + colour, never colour alone (DESIGN_SYSTEM.md §2): the direction only
 * changes the colour and the decorative arrow, never the text — `value` is
 * the caller's own string ("+3", "-1 %", "±0 sur 30 jours") and is what a
 * screen reader and a colour-blind reader both act on.
 */
const DELTA_COLOR: Record<MetricDeltaDirection, string> = {
  up: 'text-c-ok-ink',
  down: 'text-c-bad-ink',
  neutral: 'text-c-ink-3',
}

export interface MetricCardDelta {
  value: string
  direction: MetricDeltaDirection
}

export interface MetricCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string
  /** Preformatted by the caller (`src/i18n/format.ts`) — this primitive does
   * not format a number, the same rule `PriceLine` follows. */
  value: string
  delta?: MetricCardDelta
  caption?: string
  tone?: CardTone
}

function DeltaArrow({ direction }: { direction: MetricDeltaDirection }) {
  if (direction === 'neutral') {
    return (
      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
        <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }

  const rotation = direction === 'up' ? '' : 'rotate-180'

  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      aria-hidden="true"
      className={rotation}
    >
      <path
        d="M6 10V2M2.5 5.5 6 2l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * COMPONENTS.md: "Metric card: label 12/500 slate.600 → value mono 28 → help
 * 12 slate.700 → optional tertiary link." The tertiary link, when a screen
 * needs one, is a caller-composed `Button variant="tertiary"` below this
 * primitive — a metric is data, and the action next to it is the screen's to
 * decide.
 */
export const MetricCard = forwardRef<HTMLDivElement, MetricCardProps>(function MetricCard(
  { label, value, delta, caption, tone = 'default', className, ...rest },
  ref
) {
  const muted = tone === 'inverse' ? 'text-c-on-inverse-dim' : 'text-c-ink-3'
  const strong = tone === 'inverse' ? 'text-c-on-inverse' : 'text-c-ink'

  return (
    <Card ref={ref} tone={tone} className={className} {...rest}>
      <CardBody className="flex flex-col gap-2">
        <p className={cx('text-sm font-medium', muted)}>{label}</p>
        <p className={cx('font-mono text-3xl font-medium', strong)}>{value}</p>
        {delta === undefined ? null : (
          <p
            className={cx(
              'inline-flex items-center gap-1 text-sm font-medium',
              DELTA_COLOR[delta.direction]
            )}
          >
            <DeltaArrow direction={delta.direction} />
            {delta.value}
          </p>
        )}
        {caption === undefined ? null : <p className={cx('text-xs', muted)}>{caption}</p>}
      </CardBody>
    </Card>
  )
})

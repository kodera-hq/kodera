import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cx } from '../cx'

export interface PriceLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string
  /**
   * Preformatted by the caller. `docs/dev/I18N.md`: money is formatted with
   * `Intl.NumberFormat` at the boundary, on another branch (`src/i18n/
   * format.ts`) — a display primitive does not know the active locale and
   * must not guess at `5,99 €` vs `5.99 €` on its own.
   */
  amount: string
  /** e.g. "/ mois" — also the caller's string. */
  caption?: string
  /** The headline styling a tier card's annual price uses; the default is
   * the sub-line weight a line item in an invoice list uses. */
  emphasis?: boolean
}

export const PriceLine = forwardRef<HTMLDivElement, PriceLineProps>(function PriceLine(
  { label, amount, caption, emphasis = false, className, ...rest },
  ref
) {
  return (
    <div ref={ref} className={cx('flex items-baseline justify-between gap-3', className)} {...rest}>
      <span className={cx('text-c-ink', emphasis ? 'text-lg font-semibold' : 'text-sm')}>
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span
          className={cx(
            'font-mono text-c-ink',
            emphasis ? 'text-2xl font-medium' : 'text-sm font-medium'
          )}
        >
          {amount}
        </span>
        {caption === undefined ? null : <span className="text-xs text-c-ink-3">{caption}</span>}
      </span>
    </div>
  )
})

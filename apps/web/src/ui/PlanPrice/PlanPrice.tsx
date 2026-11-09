import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cx } from '../cx'

export interface PlanPriceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * The headline amount, preformatted by the caller (`src/i18n/format.ts`):
   * "134 €". A display primitive does not know the locale.
   */
  amount: string
  /** After the amount, smaller: "/ mois HT". The caller's string. */
  per?: string
  /** One line under it: the monthly price when the headline is annual, a VAT note. */
  note?: string
}

/**
 * A plan's price as a tier card shows it (P01 reference look,
 * `design specification` `design/reference/`): the amount large and bold, the
 * period beside it, a note under it.
 *
 * Plus Jakarta Sans, not the mono face: the design system keeps IBM Plex Mono
 * for technical values (addresses, hosts, keys), and in the mono face the euro
 * sign sat a whole cell away from the number. Tabular figures, as
 * docs/specs/01-order.md §4.1 asks (« monospace with tabular figures »), keep
 * amounts of one length the same width from card to card; only the face
 * changes, the deviation the reference README lists (« tabular figures in the
 * sans face »). The spec is amended where the screen adopts this primitive.
 *
 * No keyboard map: nothing here is a control. When the card is one control (a
 * radio), the control's accessible name carries the price; this text is what
 * a sighted person compares.
 */
export const PlanPrice = forwardRef<HTMLDivElement, PlanPriceProps>(function PlanPrice(
  { amount, per, note, className, ...rest },
  ref
) {
  return (
    <div ref={ref} className={cx('flex flex-col gap-1', className)} {...rest}>
      <p className="flex flex-wrap items-baseline gap-x-1">
        <span className="text-3xl leading-tight font-bold tracking-snug text-c-ink tabular-nums">
          {amount}
        </span>
        {/* 12 px, COMPONENTS.md « Tier card »'s « /mois » suffix. */}
        {per === undefined ? null : <span className="text-xs text-c-ink-3">{per}</span>}
      </p>
      {note === undefined ? null : <p className="text-xs text-c-ink-3">{note}</p>}
    </div>
  )
})

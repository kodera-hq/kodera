import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { Card, CardBody, CardHeader } from '../Card/Card'
import { cx } from '../cx'
import { PriceLine } from '../PriceLine/PriceLine'

export interface SummaryPanelRow {
  label: string
  /** Preformatted by the caller — the same contract `PriceLine.amount`
   * keeps, which renders every row here. */
  value: string
}

export interface SummaryPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string
  rows: SummaryPanelRow[]
  total: SummaryPanelRow
  note?: string
}

/**
 * The order flow's right-hand column: rows on `PriceLine`, the total on the
 * same primitive with `emphasis`, an optional note. `lg:sticky lg:top-6`
 * keeps it in view while the form beside it scrolls — `top-6` is the
 * preset's own 24 px step, not a value invented for this primitive.
 *
 * No keyboard map of its own: nothing here is a control.
 */
export const SummaryPanel = forwardRef<HTMLDivElement, SummaryPanelProps>(function SummaryPanel(
  { title, rows, total, note, className, ...rest },
  ref
) {
  return (
    <Card ref={ref} {...rest} className={cx('lg:sticky lg:top-6', className)}>
      <CardHeader>
        <h2 className="text-lg font-semibold text-c-ink">{title}</h2>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <PriceLine key={`${row.label}-${index}`} label={row.label} amount={row.value} />
        ))}
        <div className="border-t border-c-border-soft pt-3">
          <PriceLine label={total.label} amount={total.value} emphasis />
        </div>
        {note === undefined ? null : <p className="text-xs text-c-ink-3">{note}</p>}
      </CardBody>
    </Card>
  )
})

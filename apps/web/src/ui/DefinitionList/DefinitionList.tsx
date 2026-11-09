import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx'

export interface DefinitionListItem {
  term: string
  description: ReactNode
}

export interface DefinitionListProps extends Omit<HTMLAttributes<HTMLDListElement>, 'children'> {
  items: DefinitionListItem[]
}

/**
 * A real `dl`/`dt`/`dd` — a screen reader's term/description navigation
 * depends on that pairing, which a `div` grid with the right CSS but the
 * wrong elements does not give it. `display: contents` on the wrapping `div`
 * keeps the grid two-column layout while leaving the semantic nesting
 * (`dt` immediately followed by its `dd`, both inside the `dl`) intact.
 *
 * Responsive: one column under the label breakpoint, term-then-description
 * side by side above it.
 */
export const DefinitionList = forwardRef<HTMLDListElement, DefinitionListProps>(
  function DefinitionList({ items, className, ...rest }, ref) {
    return (
      <dl
        ref={ref}
        className={cx(
          'grid grid-cols-1 gap-x-6 gap-y-3',
          // No token for a 160 px term column — a bracket value, same move
          // `Table`'s status column width makes for its own missing step.
          'sm:grid-cols-[minmax(0,160px)_1fr]',
          className
        )}
        {...rest}
      >
        {items.map((item) => (
          <div className="contents" key={item.term}>
            <dt className="text-sm font-medium text-c-ink-3">{item.term}</dt>
            <dd className="text-sm text-c-ink">{item.description}</dd>
          </div>
        ))}
      </dl>
    )
  }
)

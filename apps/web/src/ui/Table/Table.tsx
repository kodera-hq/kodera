import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cx } from '../cx'

export interface TableProps extends Omit<HTMLAttributes<HTMLTableElement>, 'children'> {
  /**
   * The table's accessible name. A `<caption>` is what a screen reader
   * announces before reading the first cell, so this is required rather than
   * an optional visual label — `sr-only` here, since the heading above the
   * table usually already says this out loud on screen.
   */
  caption: string
  children: ReactNode
}

/**
 * COMPONENTS.md: "responsive horizontal scroll container." A wide table on a
 * narrow screen scrolls inside its own box rather than pushing the page wide
 * — `docs/dev/*` widths (max 1080) are for the page, not for a data table with
 * six columns of invoice history.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { caption, className, children, ...rest },
  ref
) {
  return (
    // The scroll box is a tab stop of its own: it can hold no focusable child
    // once a table has no row actions — an invoice list — and a box only a
    // pointer can scroll strands the keyboard (WCAG 2.1.1). `role="region"`
    // gives that stop something to announce, and `caption` is already the
    // table's required name, so the two say the same string by construction.
    //
    // `narrow:relative` makes the box the containing block of every `sr-only`
    // label inside the table (the caption, the actions header): each is
    // `position: absolute`, and without a positioned ancestor its static place
    // past the box's right edge widened the whole page on a phone, the
    // horizontal scroll the table's own box exists to prevent.
    //
    // Narrow layout only, on purpose. Contained, the box no longer has an
    // out-of-flow descendant escaping it, and the renderer then draws its text
    // differently — every desktop table moved by up to 82 levels per channel in
    // the pinned renderer at 768, 1024 and 1280 px. The wide layout keeps its
    // pixels, and with them the pre-existing overflow at 768–920 px wide.
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cx(
        'overflow-x-auto rounded-lg border border-c-border narrow:relative',
        'focus-visible:ring focus-visible:outline-hidden'
      )}
    >
      <table ref={ref} className={cx('w-full border-collapse text-sm', className)} {...rest}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  )
})

export const TableHead = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHead({ className, ...rest }, ref) {
  return <thead ref={ref} className={cx('bg-c-muted', className)} {...rest} />
})

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...rest }, ref) {
  return <tbody ref={ref} className={className} {...rest} />
})

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** COMPONENTS.md: "hairline slate.100 between rows" — the row a caller
   * marks as a partial failure keeps that hairline and adds its own tint;
   * `DataTable` is what sets this from data. */
  tone?: 'default' | 'danger'
}

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { tone = 'default', className, ...rest },
  ref
) {
  return (
    <tr
      ref={ref}
      className={cx(
        'border-b border-c-hairline last:border-b-0',
        tone === 'danger' && 'border-l-2 border-l-c-bad bg-red-100/60',
        className
      )}
      {...rest}
    />
  )
})

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** COMPONENTS.md: "status column fixed ≥ 120 px." */
  status?: boolean
}

export const TableHeaderCell = forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  function TableHeaderCell({ status = false, scope = 'col', className, ...rest }, ref) {
    return (
      <th
        ref={ref}
        scope={scope}
        className={cx(
          // No `tracking-*`: the preset publishes `tight` and `snug` only, so
          // the `tracking-wide` this used to carry named no step and silently
          // took Tailwind's own 0.025em. Neither guard reads `letterSpacing`,
          // which is why it survived — add a `wide` step to the tokens package
          // and consume that if the uppercase micro-label ever needs one.
          // Retain the shell's ink-2 contrast correction on the muted header.
          'px-5 py-3 text-left text-xs font-medium text-c-ink-2 uppercase',
          // COMPONENTS.md's "status column fixed ≥ 120 px" is not a step the
          // spacing scale publishes — a bracket value, no token for it.
          status && 'min-w-[120px]',
          className
        )}
        {...rest}
      />
    )
  }
)

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  function TableCell({ className, ...rest }, ref) {
    return <td ref={ref} className={cx('px-5 py-3 text-c-ink', className)} {...rest} />
  }
)

/** A data row's identifying cell, with the same appearance as a body cell. */
export const TableRowHeaderCell = forwardRef<
  HTMLTableCellElement,
  ThHTMLAttributes<HTMLTableCellElement>
>(function TableRowHeaderCell({ className, ...rest }, ref) {
  return (
    <th
      {...rest}
      ref={ref}
      scope="row"
      className={cx('px-5 py-3 text-left font-regular text-c-ink', className)}
    />
  )
})

export const TableStatusCell = forwardRef<
  HTMLTableCellElement,
  TdHTMLAttributes<HTMLTableCellElement>
>(function TableStatusCell({ className, ...rest }, ref) {
  // Same 120 px floor as `TableHeaderCell`'s status column — no token for it.
  return <td ref={ref} className={cx('min-w-[120px] px-5 py-3 text-c-ink', className)} {...rest} />
})

/**
 * COMPONENTS.md: "action `···` 32 px." The dropdown menu that fills this cell
 * arrives with the sibling `feat/ui-forms` unit; here it holds whatever the
 * caller passes — a plain `Button` in this unit's own stories.
 */
export const TableRowActions = forwardRef<
  HTMLTableCellElement,
  TdHTMLAttributes<HTMLTableCellElement>
>(function TableRowActions({ className, ...rest }, ref) {
  return <td ref={ref} className={cx('px-5 py-3 text-right', className)} {...rest} />
})

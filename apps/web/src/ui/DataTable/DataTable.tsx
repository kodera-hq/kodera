import { forwardRef } from 'react'
import type { ReactElement, ReactNode, Ref } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowActions,
  TableRowHeaderCell,
  TableStatusCell,
} from '../Table/Table'
import { cx } from '../cx'

export interface DataTableColumn<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  /** COMPONENTS.md: "status column fixed ≥ 120 px." */
  status?: boolean
  /** Identify the data row for assistive technology. */
  rowHeader?: boolean
}

export interface DataTableProps<T> {
  caption: string
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Accessible name for the row actions column header. Visually hidden
   * (`sr-only`), same treatment as `Table`'s `caption` — no customer-readable
   * string lives inside the primitive, so this comes from the caller's
   * catalogue even though it is only announced, never seen. */
  actionsLabel: string
  /**
   * Row action slot for the `···` menu. It arrives with the sibling
   * `feat/ui-forms` unit; until then the caller passes whatever it has — a
   * plain `Button` in this unit's own stories.
   */
  rowActions?: (row: T) => ReactNode
  /** COMPONENTS.md's skeleton block, styled with tokens, kept local to this
   * folder rather than the sibling `feat/ui-feedback` unit's `Skeleton`. */
  loading?: boolean
  loadingRowCount?: number
  /** Read by a `role="status"` live region while `loading` is true. Optional:
   * a screen the row count alone does not orient still renders correctly
   * without one, it just says nothing extra. */
  loadingLabel?: string
  /** Shown in place of the body when `rows` is empty and `loading` is false. */
  empty?: ReactNode
  /** A row this predicate marks true gets the partial-failure row style
   * (`Table`'s `tone="danger"`) — the status column's own text is what
   * carries the word, this is the colour half of "word + colour". */
  rowFailed?: (row: T) => boolean
}

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block h-4 animate-pulse rounded-sm bg-c-muted-2', className)}
    />
  )
}

function actionsColumnCount<T>(rowActions: DataTableProps<T>['rowActions']): number {
  return rowActions === undefined ? 0 : 1
}

/**
 * `Table` plus the parts a screen actually reaches for: column definitions
 * instead of hand-written cells, loading rows, an empty slot, and the
 * partial-failure row style. Keyboard reach for a row action is native `Tab`
 * order — there is no roving tabindex here, because each action is its own
 * focusable control and nothing about a data table changes that contract.
 */
function DataTableInner<T>(
  {
    caption,
    columns,
    rows,
    rowKey,
    actionsLabel,
    rowActions,
    loading = false,
    loadingRowCount = 5,
    loadingLabel,
    empty,
    rowFailed,
  }: DataTableProps<T>,
  ref: Ref<HTMLTableElement>
) {
  const columnCount = columns.length + actionsColumnCount(rowActions)
  const showEmpty = !loading && rows.length === 0 && empty !== undefined

  return (
    <Table ref={ref} caption={caption}>
      <TableHead>
        <TableRow>
          {columns.map((column) => (
            <TableHeaderCell key={column.key} status={column.status ?? false}>
              {column.header}
            </TableHeaderCell>
          ))}
          {rowActions === undefined ? null : (
            <TableHeaderCell>
              <span className="sr-only">{actionsLabel}</span>
            </TableHeaderCell>
          )}
        </TableRow>
      </TableHead>
      <TableBody aria-busy={loading ? true : undefined}>
        {loading ? (
          <>
            {loadingLabel === undefined ? null : (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-0">
                  <span role="status" className="sr-only">
                    {loadingLabel}
                  </span>
                </TableCell>
              </TableRow>
            )}
            {/* Index as key is deliberate: a skeleton row stands for "a row
                is coming", not for a record with an identity of its own —
                there is nothing else to key it by. */}
            {Array.from({ length: loadingRowCount }, (_, index) => (
              <TableRow key={index}>
                {columns.map((column) => {
                  const Cell = column.status ? TableStatusCell : TableCell
                  return (
                    <Cell key={column.key}>
                      <SkeletonBlock className="w-2/3" />
                    </Cell>
                  )
                })}
                {rowActions === undefined ? null : (
                  <TableRowActions>
                    <SkeletonBlock className="ml-auto w-12" />
                  </TableRowActions>
                )}
              </TableRow>
            ))}
          </>
        ) : showEmpty ? (
          <TableRow>
            <TableCell colSpan={columnCount} className="py-8 text-center">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => {
            const failed = rowFailed?.(row) === true
            return (
              <TableRow key={rowKey(row)} tone={failed ? 'danger' : 'default'}>
                {columns.map((column) => {
                  const Cell = column.rowHeader
                    ? TableRowHeaderCell
                    : column.status
                      ? TableStatusCell
                      : TableCell
                  return <Cell key={column.key}>{column.render(row)}</Cell>
                })}
                {rowActions === undefined ? null : (
                  <TableRowActions>{rowActions(row)}</TableRowActions>
                )}
              </TableRow>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}

/**
 * `forwardRef` with a type parameter needs the explicit cast below: React's
 * own `forwardRef` type erases a component's generics, which would make every
 * caller's `T` collapse to `unknown`. This is the standard escape hatch, not a
 * loosening of the type — `DataTableInner` above is still checked against
 * `DataTableProps<T>` for every `T` it is called with.
 */
export const DataTable = forwardRef(DataTableInner) as <T>(
  props: DataTableProps<T> & { ref?: Ref<HTMLTableElement> }
) => ReactElement

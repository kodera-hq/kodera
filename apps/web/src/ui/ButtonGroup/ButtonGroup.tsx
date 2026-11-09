import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cx } from '../cx'

export type ButtonGroupOrientation = 'horizontal' | 'vertical'

export interface ButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Read before the buttons it contains — required in practice even though
   * TypeScript cannot enforce it here without excluding every other `aria-*`
   * prop `HTMLAttributes` already carries. A `role="group"` with no name reads
   * as an unlabelled cluster of buttons to anyone not looking at the screen.
   */
  'aria-label'?: string
  /**
   * Segmented style: the buttons touch, the border between two neighbours is
   * shared rather than doubled, and only the outer corners round. Structural —
   * it does not change how many buttons there are or how they are reached.
   */
  attached?: boolean
  orientation?: ButtonGroupOrientation
}

/**
 * A set of independent actions, not one composite control: `Tab` visits every
 * button in the group in order, same as if there were no wrapper at all.
 * `RadioGroup` is the primitive for "one of these", with the roving tabindex
 * that implies; this one is "any of these, on their own".
 */
export const ButtonGroup = forwardRef<HTMLDivElement, ButtonGroupProps>(function ButtonGroup(
  { attached = false, orientation = 'horizontal', className, children, ...rest },
  ref
) {
  const horizontal = orientation === 'horizontal'

  return (
    <div
      {...rest}
      ref={ref}
      role="group"
      className={cx(
        'inline-flex',
        horizontal ? 'flex-row' : 'flex-col',
        attached
          ? cx(
              // Focus rings sit above the neighbour's border rather than under
              // it, so the ring on a middle segment is not half-hidden.
              '[&>*]:relative [&>*:focus-visible]:z-10',
              horizontal
                ? '[&>*:not(:first-child)]:-ml-px [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none'
                : '[&>*:not(:first-child)]:-mt-px [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none'
            )
          : 'gap-2',
        className
      )}
    >
      {children}
    </div>
  )
})

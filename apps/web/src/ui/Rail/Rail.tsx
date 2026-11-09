import { Slot, Slottable } from '@radix-ui/react-slot'
import { Fragment, createElement, forwardRef, isValidElement } from 'react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx'
import { Tooltip } from '../Tooltip/Tooltip'

/**
 * The workspace's module rail (P01 of the product reference;
 * `design specification` `design/reference/p01-shell.html`): a column of
 * destinations on the inverse ground, left of everything else, in every theme.
 * Presentational only — what the destinations are, which one is current and
 * where each goes is the caller's (`src/app/ModuleRail.tsx` decides that from
 * Core's applications and the role matrix). The rail grants nothing.
 *
 * Geometry: `shell-rail-width` (the tokens package's) for the column, a 48 px
 * square per item. Icons only (owner decision, 2026-11-07): an item's name is its
 * accessible name and shows beside it as a tooltip on hover and on focus, not
 * as a label under the glyph.
 *
 * Landmark: a named `nav`. The shell already has a second `nav` (the sidebar),
 * so `label` is required, and it is how the two are told apart.
 */
export interface RailProps {
  /** The landmark's accessible name, from the caller's catalogue. */
  label: string
  /** Above the list: the maker's mark, linking home. Brand, not a module. */
  mark?: ReactNode
  /** Below the list, after a rule: the signed-in person, presentational. */
  footer?: ReactNode
  /** `RailItem`s, one per destination. */
  children: ReactNode
}

export function Rail({ label, mark, footer, children }: RailProps) {
  return (
    <nav
      aria-label={label}
      className="sticky top-0 flex h-screen w-shell-rail-width shrink-0 flex-col items-center gap-3 bg-c-inverse py-4"
    >
      {mark}
      <ul
        className={cx(
          'flex w-full flex-1 flex-col items-center gap-1',
          mark === undefined ? '' : 'border-t border-c-rail-line pt-3'
        )}
      >
        {children}
      </ul>
      {footer === undefined ? null : (
        <div className="flex w-full shrink-0 justify-center border-t border-c-rail-line pt-3">
          {footer}
        </div>
      )}
    </nav>
  )
}

// One item, a 48 px square. The focus ring is the on-inverse
// tone: the default ring, the theme's accent ink, is 2.20 : 1 on the rail's
// `c-inverse` in light; `c-on-inverse` is gated against `inverse` in every theme.
// Centred in the 76 px rail, a 48 px item leaves 14 px to the rail's edge and the 40 px maker mark
// 18 px: 20 puts the tooltip past the rail (6 px and 2 px), on the sidebar's ground, where its edge
// shows in every theme.
export const RAIL_TIP_OFFSET = 20

const ITEM_BASE =
  'relative flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring focus-visible:ring-c-on-inverse'

// The current item is the `c-action` plate plus a bar in `c-on-inverse` inside
// it. The plate alone is 2.65 : 1 against the rail in light, so the bar (6.70 /
// 4.66 / 4.79 : 1 against the plate, as `on-inverse` on `action` is gated) is the
// cue that does not rest on colour; `aria-current` says it to assistive technology.
const ITEM: Record<'idle' | 'current', string> = {
  idle: `${ITEM_BASE} text-c-on-inverse-dim hover:bg-c-inverse-2 hover:text-c-on-inverse`,
  current: `${ITEM_BASE} bg-c-action text-c-on-inverse`,
}

export interface RailItemProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** The item's accessible name, shown as its tooltip on hover and on focus. */
  label: string
  /** The destination's glyph, decorative (`aria-hidden` on the caller's SVG). */
  icon: ReactNode
  /** The destination on screen: the plate, the bar and `aria-current="page"`. */
  current?: boolean
  /**
   * Something waits there (people in a waiting room, unread activity): a dot in
   * `c-bad-on-dark`, gated against `inverse`, and this text read after the name.
   * Omit it when nothing waits — a dot with no reason is noise.
   */
  attention?: string
  /**
   * For a destination that opens elsewhere (a tenant application in a new tab):
   * appended to the accessible name, e.g. « s'ouvre dans un nouvel onglet ».
   */
  opensElsewhere?: string
  /**
   * Render the caller's element — exactly one, such as the router's `Link` —
   * instead of an `<a>`. Its
   * own props are kept, except `aria-current`, `aria-label` and `title`, which
   * are the item's state and cannot be taken back off by the child. The item's
   * classes, marker and glyph are merged into it. Note that the router's
   * `Link` also sets `aria-current="page"` itself on its active route.
   */
  asChild?: boolean
}

/** A destination in the rail. Rendered inside an `<li>` it creates itself. */
export const RailItem = forwardRef<HTMLAnchorElement, RailItemProps>(function RailItem(
  {
    label,
    icon,
    current = false,
    attention,
    opensElsewhere,
    asChild = false,
    className,
    children,
    ...rest
  },
  ref
) {
  const Comp = asChild ? Slot : 'a'
  const name = opensElsewhere === undefined ? label : `${label} — ${opensElsewhere}`
  const accessibleName = attention === undefined ? name : `${name}, ${attention}`
  // Slot merges the child's props over the item's: strip the item's state from
  // the child so it cannot override it (src/ui/README.md, "A state under asChild").
  if (asChild && (!isValidElement(children) || children.type === Fragment)) {
    // Slot needs exactly one element to merge into; anything else would either
    // throw deep inside Radix or silently render an unstyled, unnamed link.
    throw new Error('RailItem asChild needs exactly one element child, such as the router’s Link')
  }
  const slotted =
    asChild && isValidElement<Record<string, unknown>>(children)
      ? (() => {
          const {
            'aria-current': _current,
            'aria-label': _name,
            title: _title,
            ...keep
          } = children.props
          return createElement(children.type, { ...keep, key: children.key })
        })()
      : children
  // A destination announced as opening elsewhere does open elsewhere, unless the
  // caller says otherwise.
  const elsewhere =
    opensElsewhere !== undefined && !asChild ? { target: '_blank', rel: 'noreferrer' } : {}
  return (
    <li>
      <Tooltip content={label} side="right" sideOffset={RAIL_TIP_OFFSET} names>
        <Comp
          {...elsewhere}
          {...rest}
          ref={ref}
          // No `title`: the tooltip shows the name, and a title would draw the browser's own as well.
          aria-label={accessibleName}
          aria-current={current ? 'page' : undefined}
          className={cx(current ? ITEM.current : ITEM.idle, className)}
        >
          {current ? (
            <span
              aria-hidden="true"
              className="absolute top-4 left-1 h-4 w-1 rounded-sm bg-c-on-inverse"
            />
          ) : null}
          {icon}
          <Slottable>{slotted}</Slottable>
          {attention === undefined ? null : (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 h-2 w-2 rounded-full bg-c-bad-on-dark ring-2 ring-c-inverse"
            />
          )}
        </Comp>
      </Tooltip>
    </li>
  )
})

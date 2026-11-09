import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { EspaceGlyph } from '../icons/EspaceGlyph'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

/**
 * A category of Espace's sidebar (`design specification` `design/reference/p02-messages.html`,
 * `.sec`): a header that folds and unfolds the rows under it. One category
 * mixes text channels (`ChannelRow`) and audio rooms (`RoomRow`), as the owner
 * approved (M-D4). Presentational: the caller owns the rows and, if it wants
 * to, the open state.
 *
 * The header is a disclosure button: `aria-expanded` says whether the rows
 * show, `aria-controls` names the list, and the chevron turns a quarter turn,
 * so the state is a shape as well as an attribute. Sentence case, `c-ink-3`
 * semibold, the reference's deviation from the mock's capitals.
 *
 * Open state is uncontrolled by default (`defaultOpen`, true); pass `open`
 * with `onOpenChange` to control it.
 */
export interface SidebarCategoryProps {
  /** The category's name, from the organisation's data. Also the list's name. */
  label: string
  description?: string | undefined
  /** Controlled open state. Leave it out for the category to keep its own. */
  open?: boolean
  /** Uncontrolled initial state. */
  defaultOpen?: boolean
  /** Called with the next state on every toggle, controlled or not. */
  onOpenChange?: (open: boolean) => void
  /**
   * Beside the header, right-aligned: icon buttons such as "create a channel".
   * Each direct child gets the 44 px floor under `narrow:`.
   */
  actions?: ReactNode
  /** `ChannelRow`s and `RoomRow`s; each renders its own `<li>`. */
  children: ReactNode
}

/**
 * `TOUCH_TARGET` (`src/ui/touchTarget.ts`) for each direct child of the
 * actions slot: the caller's icon buttons are its children, so the floor is set
 * from the wrapper rather than trusted to every caller. Written out whole,
 * since Tailwind reads classes from the source text;
 * `SidebarCategory.test.tsx` pins it to `TOUCH_TARGET`, child-prefixed.
 */
export const ACTIONS_TOUCH_TARGET = '*:narrow:min-h-[44px] *:narrow:min-w-[44px]'

export function SidebarCategory({
  label,
  description,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  actions,
  children,
}: SidebarCategoryProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen)
  const open = controlledOpen ?? ownOpen
  const id = useId()
  const listId = `${id}-rows`
  const headerId = `${id}-header`

  function toggle() {
    const next = !open
    if (controlledOpen === undefined) setOwnOpen(next)
    onOpenChange?.(next)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pt-3 pr-2 pb-1">
        <button
          id={headerId}
          type="button"
          aria-expanded={open}
          aria-describedby={description ? `${id}-description` : undefined}
          aria-controls={listId}
          onClick={toggle}
          className={cx(
            'flex min-h-6 min-w-0 flex-1 items-center gap-1 rounded-sm px-1 text-left text-xs font-semibold text-c-ink-3',
            'hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
            TOUCH_TARGET_HEIGHT
          )}
        >
          <EspaceGlyph
            name="chevron"
            className={cx(
              'h-3 w-3 shrink-0 transition-transform duration-fast',
              open ? 'rotate-90' : ''
            )}
          />
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {actions === undefined ? null : (
          <div data-actions="" className={cx('flex shrink-0 items-center', ACTIONS_TOUCH_TARGET)}>
            {actions}
          </div>
        )}
      </div>
      {description ? (
        <p
          id={`${id}-description`}
          title={description}
          className="truncate px-2 pb-1 text-xs text-c-ink-3"
        >
          {description}
        </p>
      ) : null}
      <ul id={listId} aria-labelledby={headerId} hidden={!open} className="flex flex-col">
        {children}
      </ul>
    </div>
  )
}

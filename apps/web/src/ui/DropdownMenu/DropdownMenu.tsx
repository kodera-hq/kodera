import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu'
import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

export interface DropdownMenuItemData {
  label: string
  onSelect: () => void
  /** Red text, for an action like removing a person or deleting a record —
   * COMPONENTS.md's row action menu. */
  destructive?: boolean
  disabled?: boolean
}

export type DropdownMenuEntry = DropdownMenuItemData | { type: 'separator' }

export interface DropdownMenuProps {
  /** Rendered as the trigger with `asChild` — the table row's `···` button. */
  trigger: ReactNode
  /**
   * Radix's `DropdownMenu.Content` renders `role="menu"` with no accessible
   * name of its own; wired to `aria-label`. From the caller's message
   * catalogue — usually names what the menu acts on, e.g. "Actions pour
   * Camille Dubois".
   */
  label: string
  items: DropdownMenuEntry[]
  align?: 'start' | 'center' | 'end'
  /** See `Dialog`'s doc comment — same reason, same story-only use. */
  container?: HTMLElement | null
}

function isSeparator(entry: DropdownMenuEntry): entry is { type: 'separator' } {
  return 'type' in entry && entry.type === 'separator'
}

/**
 * Keyboard: `Tab` reaches the trigger; `Enter`, `Space` or `ArrowDown` opens
 * it and moves focus to the first item. `ArrowUp`/`ArrowDown` move between
 * items, skipping separators and disabled ones; typing a letter jumps to the
 * next item starting with it. `Enter`/`Space` selects the focused item and
 * closes the menu; `Escape` closes without selecting and returns focus to
 * the trigger.
 *
 * Data-driven rather than composed from child elements: the `···` row action
 * menu this exists for is always a flat list of named actions, so an array
 * of `{ label, onSelect }` covers it without a caller assembling
 * `DropdownMenu.Item` by hand for every row.
 */
export const DropdownMenu = forwardRef<HTMLDivElement, DropdownMenuProps>(function DropdownMenu(
  { trigger, label, items, align = 'end', container },
  ref
) {
  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal container={container}>
        <RadixDropdownMenu.Content
          ref={ref}
          aria-label={label}
          align={align}
          sideOffset={4}
          className={cx(
            'z-50 rounded-md border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2',
            'focus:outline-hidden',
            // 180 px is not on the tokens package's spacing grid and
            // COMPONENTS.md gives the row action menu no width of its own —
            // the same gap `Popover`'s `min-w-[220px]` notes.
            'min-w-[180px]'
          )}
        >
          {items.map((entry, index) =>
            isSeparator(entry) ? (
              // A separator carries no identity of its own to key by, so its
              // position in the list is the only stable key available.
              <RadixDropdownMenu.Separator
                key={`separator-${index}`}
                className="my-1 h-px bg-c-border"
              />
            ) : (
              <RadixDropdownMenu.Item
                key={entry.label}
                {...(entry.disabled === undefined ? {} : { disabled: entry.disabled })}
                data-destructive={entry.destructive === true ? '' : undefined}
                onSelect={entry.onSelect}
                className={cx(
                  'flex h-8 cursor-pointer items-center rounded-sm px-3 text-sm outline-hidden',
                  TOUCH_TARGET_HEIGHT,
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
                  // The highlight is the only cue of the keyboard position (the item
                  // draws no ring), and no tint alone separates from `elevated` in
                  // dark (1.02 : 1 for accent-soft). So it is tint, ink and a 1 px
                  // inset edge in the item's own ink, which clears 3:1 on the menu
                  // in every theme; text on the tint is gated in the tokens package.
                  'data-[highlighted]:ring-1 data-[highlighted]:ring-inset',
                  entry.destructive === true
                    ? 'text-c-bad-ink data-[highlighted]:bg-c-bad-soft data-[highlighted]:ring-c-bad-ink'
                    : 'text-c-ink data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink data-[highlighted]:ring-c-accent-ink'
                )}
              >
                {entry.label}
              </RadixDropdownMenu.Item>
            )
          )}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  )
})

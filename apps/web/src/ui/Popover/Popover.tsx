import * as RadixPopover from '@radix-ui/react-popover'
import { forwardRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cx } from '../cx'
import { FOCUS_GROUND_ELEVATED } from '@/ui/focusGround'

export type PopoverSide = 'top' | 'right' | 'bottom' | 'left'
export type PopoverAlign = 'start' | 'center' | 'end'

export interface PopoverProps {
  /** Rendered as the trigger with `asChild` — usually a `Button`. */
  trigger: ReactNode
  /**
   * Radix's `Popover.Content` renders `role="dialog"` unconditionally, which
   * axe's `aria-dialog-name` rule requires an accessible name for — wired to
   * `aria-label` here rather than shown, since not every popover has (or
   * needs) a visible heading. From the caller's message catalogue, like
   * `Dialog`'s `title`.
   */
  label: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  side?: PopoverSide
  align?: PopoverAlign
  children: ReactNode
  /** See `Dialog`'s doc comment — same reason, same story-only use. */
  container?: HTMLElement | null
  /**
   * What the popover is placed against, when not its trigger: e.g. the whole composer box, so a
   * palette opened from a button under the field does not cover the field.
   */
  anchorRef?: RefObject<HTMLElement | null>
}

/**
 * Keyboard: `Tab` reaches the trigger, `Enter`/`Space` opens it, focus moves
 * into the content. `Escape` closes and returns focus to the trigger; a
 * click outside closes it without moving focus anywhere in particular.
 *
 * Unlike `Dialog`, not modal: the page behind it stays interactive, and
 * nothing here traps focus inside. Use this for a filter, a compact form or
 * anything anchored to the control that opened it; `Dialog` is for something
 * that has to be dealt with before the rest of the page matters again.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    trigger,
    label,
    open,
    defaultOpen,
    onOpenChange,
    side = 'bottom',
    align = 'start',
    children,
    container,
    anchorRef,
  },
  ref
) {
  const rootProps = {
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  }

  return (
    <RadixPopover.Root {...rootProps}>
      {anchorRef === undefined ? null : <RadixPopover.Anchor virtualRef={anchorRef} />}
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal container={container}>
        <RadixPopover.Content
          ref={ref}
          aria-label={label}
          // Ours to find a popover by (the live view's channel keys leave theirs alone), where
          // Radix's own wrapper attribute is its internal.
          data-popover=""
          side={side}
          align={align}
          sideOffset={6}
          className={cx(
            'z-50 rounded-md border border-c-border bg-c-elevated p-4 shadow-pop shadow-c-shadow-2',
            FOCUS_GROUND_ELEVATED,
            'focus:outline-hidden',
            // 220 px is not on the tokens package's spacing grid and
            // COMPONENTS.md gives a popover no width of its own — a layout
            // container size, the same gap `Toast`'s viewport notes.
            'min-w-[220px]'
          )}
        >
          {children}
          {/* Against a custom anchor the arrow would point at it, not at the trigger. */}
          {anchorRef === undefined ? <RadixPopover.Arrow className="fill-c-surface" /> : null}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
})

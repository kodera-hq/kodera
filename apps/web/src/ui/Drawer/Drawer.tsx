import * as RadixDialog from '@radix-ui/react-dialog'
import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { CloseIcon } from '../icons/Close'
import { closeAutoFocusHandler } from '../returnFocus'
import type { FocusTarget } from '../returnFocus'
import { FOCUS_GROUND_ELEVATED } from '@/ui/focusGround'

export type DrawerSize = 'sm' | 'md' | 'lg'
export type DrawerSide = 'right' | 'bottom'

/**
 * Fixed pixel widths — a side panel is sized against the viewport edge it
 * slides from, not against the spacing grid a padding value comes from
 * (`src/ui/README.md`). None of the three is in COMPONENTS.md yet; these
 * stand in until the design workstream gives the drawer its own numbers, the
 * same gap `Dialog`'s `md`/`lg` sizes note.
 */
const SIZE: Record<DrawerSize, string> = {
  sm: 'w-[360px]',
  md: 'w-[480px]',
  lg: 'w-[640px]',
}

/**
 * The edge the panel is attached to. `right` is the side panel every screen
 * opens; `bottom` is the narrow layout's sheet (docs/specs/00-shell-and-login.md
 * §4.5), full width and as tall as its content, never taller than the screen.
 * `size` only sets a width, so it applies to `right` alone. Both clear a
 * phone's safe areas themselves (`drawer-edges`, `safe-area-bottom`,
 * `src/index.css`); on a desktop every inset is 0.
 */
const SIDE: Record<DrawerSide, string> = {
  right: 'drawer-edges inset-y-0 right-0 max-w-full',
  bottom: 'inset-x-0 bottom-0 max-h-full rounded-t-lg px-4 pt-4',
}

export interface DrawerProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: ReactNode
  title: string
  description?: string
  closeLabel: string
  size?: DrawerSize
  side?: DrawerSide
  footer?: ReactNode
  children: ReactNode
  /** See `Dialog`'s doc comment — the same gap for a panel opened without a
   * trigger, the same ref read at close time. */
  returnFocusTo?: FocusTarget
  /** See `Dialog`'s doc comment — same reason, same story-only use. */
  container?: HTMLElement | null
}

/**
 * `Dialog`'s content, Radix Primitives directly rather than composed from it:
 * a side panel's positioning and its slide-in edge do not share a single class
 * with a centred dialog's, so this is its own Radix Dialog rather than a
 * variant bolted onto `Dialog`'s.
 *
 * Keyboard: identical contract to `Dialog` — `Tab`/`Shift+Tab` stay inside the
 * panel, `Escape` closes and returns focus to the trigger (or to
 * `returnFocusTo` when there is none). Use this over
 * `Dialog` for a task too long for a centred dialog — a record's full detail,
 * a multi-field form — where the page behind it stays visible as context.
 */
export const Drawer = forwardRef<HTMLDivElement, DrawerProps>(function Drawer(
  {
    open,
    defaultOpen,
    onOpenChange,
    trigger,
    title,
    description,
    closeLabel,
    size = 'md',
    side = 'right',
    footer,
    children,
    returnFocusTo,
    container,
  },
  ref
) {
  const rootProps = {
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  }

  return (
    <RadixDialog.Root {...rootProps}>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal container={container}>
        {/* `z-40`, as in `Dialog`: above the narrow layout's sticky bars. */}
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-c-scrim" />
        <RadixDialog.Content
          ref={ref}
          className={cx(
            'fixed z-40 flex flex-col border-c-border bg-c-elevated shadow-pop shadow-c-shadow-2',
            // The edge only where the panel meets the page, not along the viewport.
            side === 'right' ? 'border-l' : 'border-t',
            FOCUS_GROUND_ELEVATED,
            SIDE[side],
            side === 'right' ? SIZE[size] : 'safe-area-bottom'
          )}
          onCloseAutoFocus={closeAutoFocusHandler(returnFocusTo)}
        >
          <div className="flex items-start justify-between gap-4">
            <RadixDialog.Title className="text-lg font-semibold text-c-ink">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close
              aria-label={closeLabel}
              className={cx(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-c-ink-3 opacity-70',
                TOUCH_TARGET,
                '-mt-2 -mr-2 hover:opacity-100 focus-visible:opacity-100',
                'focus-visible:ring focus-visible:outline-hidden'
              )}
            >
              <CloseIcon />
            </RadixDialog.Close>
          </div>
          {description === undefined ? null : (
            <RadixDialog.Description className="mt-2 text-sm text-c-ink-3">
              {description}
            </RadixDialog.Description>
          )}
          <div className={cx('mt-4 flex-1 overflow-y-auto', side === 'bottom' && 'pb-4')}>
            {children}
          </div>
          {footer === undefined ? null : (
            <div className="mt-6 flex justify-end gap-3 border-t border-c-border pt-4">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
})

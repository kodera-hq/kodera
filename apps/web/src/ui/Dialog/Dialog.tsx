import * as RadixDialog from '@radix-ui/react-dialog'
import { forwardRef, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { CloseIcon } from '../icons/Close'
import { closeAutoFocusHandler } from '../returnFocus'
import type { FocusTarget } from '../returnFocus'
import { FOCUS_GROUND_ELEVATED } from '@/ui/focusGround'

export type DialogSize = 'sm' | 'md' | 'lg'

/**
 * `sm` is the confirm variant's own 420 px (COMPONENTS.md: "Confirm dialog:
 * … width 420") — a fixed pixel width, like the sidebar's 232 px and the
 * main column's 1080 px max-width, not a spacing step, so it is the one
 * arbitrary value in this file rather than a class the token grid has no
 * name for. `md`/`lg` are not specified there either: bracket px values
 * standing in for Tailwind's own `xl`/`3xl` max-width steps (576 px / 768 px,
 * that rem scale converted so the spacing guard can judge them the same way
 * as `sm`) until the design workstream gives them a number, the same gap
 * `Drawer`'s three sizes and `Toast`'s viewport width note.
 */
const SIZE: Record<DialogSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[576px]',
  lg: 'max-w-[768px]',
}

export interface DialogProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Rendered as the trigger with `asChild` — usually a `Button`. Omit it for
   * a dialog the caller opens itself, driven by `open`/`onOpenChange`. */
  trigger?: ReactNode
  /** The dialog's accessible name, wired to `aria-labelledby` by Radix. */
  title: string
  /** The dialog's accessible description, wired to `aria-describedby`. */
  description?: string
  /** What a screen reader hears for the close control — a primitive holds no
   * string a customer reads, so this has no default. */
  closeLabel: string
  /**
   * `false` for a dialog that has one way forward and no way back: no close
   * control is drawn, and `Escape` and a press outside do nothing. The footer
   * then carries the only action, and opening lands on it. A close control
   * that is drawn, takes focus and does nothing is worse than none. Default
   * `true`.
   */
  dismissible?: boolean
  size?: DialogSize
  /** Usually a `Button` pair — Cancel and the primary or destructive action. */
  footer?: ReactNode
  children: ReactNode
  /**
   * Where focus goes on close, instead of `trigger`. Radix returns focus to
   * its own trigger; a dialog opened without one — from a row menu, or from
   * whichever of two buttons the screen shows — has nothing to return to and
   * focus lands on `body`. Record the opener in a ref when opening (`onClick`'s
   * `event.currentTarget`), pass the ref here; it is read at close time, not
   * at render. An empty ref falls back to Radix's behaviour.
   */
  returnFocusTo?: FocusTarget
  /**
   * Portal target, forwarded to Radix's `Dialog.Portal`. Product code never
   * passes this — Radix defaults to `document.body`. `src/ui/stories-a11y.test.tsx`
   * scans only the story's own render container, and a portal renders as a
   * sibling of it in the real DOM; stories that need the open dialog judged
   * pass a container node that lives inside that render tree instead.
   */
  container?: HTMLElement | null
  /**
   * Where focus lands on open. `close` (the default) suits content that
   * varies; `title` reads the heading first and keeps any action — above all
   * a destructive one — from being the focused control (03-people.md §10).
   * A ref names one field of the content instead, for a dialog whose whole
   * point is typing into it, such as the workspace's channel search. An empty
   * ref at open time falls back to the close control.
   */
  initialFocus?: 'close' | 'title' | RefObject<HTMLElement | null>
}

/**
 * Keyboard: `Tab`/`Shift+Tab` cycle through the content only — focus cannot
 * reach the page behind it. `Escape` closes and returns focus to the
 * trigger. Opening moves focus to the close control first, since dialog
 * content varies (some open with nothing else focusable at all). With
 * `dismissible={false}` there is no close control and `Escape` does nothing:
 * opening moves focus to the first control of the content or the footer.
 *
 * `ConfirmDestructive` is the specialised confirm variant built on this.
 * `Drawer` is the same primitive, styled as a right-side panel, for a task
 * too long for a centred dialog.
 */
export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  {
    open,
    defaultOpen,
    onOpenChange,
    trigger,
    title,
    description,
    closeLabel,
    dismissible = true,
    size = 'md',
    footer,
    children,
    returnFocusTo,
    container,
    initialFocus = 'close',
  },
  ref
) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  // `exactOptionalPropertyTypes` treats `open={open}` as assigning `open:
  // undefined` when the caller omitted it — a different thing, to Radix's own
  // optional prop, from omitting the attribute entirely. Spreading only the
  // props actually given keeps an uncontrolled `Dialog` uncontrolled.
  const rootProps = {
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  }

  return (
    <RadixDialog.Root {...rootProps}>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal container={container}>
        {/* `z-40`: above the narrow layout's sticky top bar and tab bar (`z-10`,
         * `src/app/NarrowShell.tsx`), which would otherwise paint over a modal
         * rendered earlier in the stacking order. Below the `z-50` popovers a
         * dialog can itself open. */}
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-c-scrim" />
        {/* `p-4` (16 px) on every side is the 32 px viewport gutter this
         * dialog keeps on a narrow screen — a spacing step doing the job a
         * `calc()` width used to, so `Content` itself can stay a plain
         * `w-full` up to its size's `max-w` instead of computing one. */}
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <RadixDialog.Content
            ref={ref}
            className={cx(
              'w-full rounded-lg border border-c-border bg-c-elevated p-6 shadow-pop shadow-c-shadow-2',
              FOCUS_GROUND_ELEVATED,
              SIZE[size]
            )}
            onCloseAutoFocus={closeAutoFocusHandler(returnFocusTo)}
            // Two refusals, each with its own test. `onInteractOutside` is
            // the one handler Radix calls for every way of acting outside the
            // content, a press included: a second handler for the press alone
            // would be a line no test could tell from its absence.
            {...(dismissible
              ? {}
              : {
                  onEscapeKeyDown: (event) => event.preventDefault(),
                  onInteractOutside: (event) => event.preventDefault(),
                })}
            {...(initialFocus === 'close'
              ? {}
              : {
                  onOpenAutoFocus: (event: Event) => {
                    const target =
                      initialFocus === 'title' ? titleRef.current : initialFocus.current
                    if (target === null) return
                    event.preventDefault()
                    target.focus()
                  },
                })}
          >
            <div className="flex items-start justify-between gap-4">
              <RadixDialog.Title
                ref={titleRef}
                tabIndex={initialFocus === 'title' ? -1 : undefined}
                className="text-lg font-semibold text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                {title}
              </RadixDialog.Title>
              {dismissible ? (
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
              ) : null}
            </div>
            {description === undefined ? null : (
              <RadixDialog.Description className="mt-2 text-sm text-c-ink-3">
                {description}
              </RadixDialog.Description>
            )}
            <div className="mt-4">{children}</div>
            {footer === undefined ? null : (
              <div className="mt-6 flex justify-end gap-3">{footer}</div>
            )}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
})

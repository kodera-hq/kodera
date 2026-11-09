import * as RadixDialog from '@radix-ui/react-dialog'
import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cx } from './cx'
import { closeAutoFocusHandler } from './returnFocus'
import type { FocusTarget } from './returnFocus'

/**
 * Full-screen workspace modals on the same Radix dialog as `ui/Dialog`, keeping their own
 * wide layout: focus is trapped inside, `Escape` and a press outside close, and focus returns to
 * the control that opened it. The content is `role="dialog"` with `aria-modal="true"`, named by
 * its `WorkspaceDialogTitle`.
 *
 * Radix returns focus to its own trigger, and these dialogs are opened from plain buttons, so the
 * focused element is recorded when the dialog opens and focused again when it closes — unless it
 * left the page meanwhile (a menu item that closed its menu), in which case Radix decides.
 */
export interface WorkspaceDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly className?: string | undefined
  /** For content whose own heading the dialog cannot reach; otherwise use `WorkspaceDialogTitle`. */
  readonly 'aria-label'?: string | undefined
  readonly 'data-testid'?: string | undefined
  readonly returnFocusTo?: RefObject<HTMLElement | null> | undefined
  readonly children: ReactNode
}

export function WorkspaceDialog({
  open,
  onClose,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
  children,
  returnFocusTo,
}: WorkspaceDialogProps) {
  const openerRef = useRef<HTMLElement | null>(null)
  const returnTarget: FocusTarget = {
    get current() {
      const opener = returnFocusTo?.current ?? openerRef.current
      return opener !== null && opener.isConnected ? opener : null
    },
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-c-sunken" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <RadixDialog.Content
            aria-modal="true"
            aria-describedby={undefined}
            aria-label={ariaLabel}
            data-testid={testId}
            onOpenAutoFocus={() => {
              const active = document.activeElement
              openerRef.current = active instanceof HTMLElement ? active : null
            }}
            onCloseAutoFocus={closeAutoFocusHandler(returnTarget)}
            className={cx('focus-visible:outline-hidden', className)}
          >
            {children}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** The dialog's accessible name: its heading, wired to `aria-labelledby`. */
export const WorkspaceDialogTitle = RadixDialog.Title

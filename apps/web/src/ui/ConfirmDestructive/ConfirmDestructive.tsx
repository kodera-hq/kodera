import { forwardRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../Button/Button'
import { Dialog } from '../Dialog/Dialog'
import type { FocusTarget } from '../returnFocus'
import { TextField } from '../TextField/TextField'

type TypedConfirmationProps =
  | {
      /** Disables the destructive action until the typed value matches
       * `confirmationValue` exactly — for the actions COMPONENTS.md's "Empty /
       * loading / confirm" section does not cover with a plain Cancel/Confirm
       * pair, e.g. deleting the organisation itself. */
      requireTypedConfirmation: true
      confirmationValue: string
      /** The field's own label — what to type, from the caller. */
      confirmationLabel: string
    }
  | {
      requireTypedConfirmation?: false
      confirmationValue?: undefined
      confirmationLabel?: undefined
    }

export type ConfirmDestructiveProps = TypedConfirmationProps & {
  trigger?: ReactNode
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Names the object — "Retirer Camille Dubois ?", never "Confirmer ?". */
  title: string
  /** Names the consequence — what is lost, said plainly. */
  consequence: string
  cancelLabel: string
  confirmLabel: string
  closeLabel: string
  onConfirm: () => void
  /** Passed straight to the confirm `Button` — a destructive action that
   * takes a moment (an API call) still gets the same busy state as any
   * other. */
  loading?: boolean
  /** Forwarded to the underlying `Dialog`'s `returnFocusTo` — for the
   * `defaultOpen` case, the one way this opens without its own trigger. */
  returnFocusTo?: FocusTarget
  /** Forwarded to the underlying `Dialog`'s own `container` — see its doc
   * comment. Product code never passes this. */
  container?: HTMLElement | null
  /** Forwarded to the underlying `Dialog`'s own `initialFocus`. */
  initialFocus?: 'close' | 'title'
}

/**
 * `Dialog`, fixed at its `sm` (420 px) size, with the shape COMPONENTS.md's
 * confirm dialog asks for: names the object and the consequence, a secondary
 * Cancel next to a destructive primary. Owns its own open state — a screen
 * that needs to drive this from somewhere other than its own trigger (a row
 * menu, say) composes `Dialog` directly instead.
 *
 * Keyboard: identical to `Dialog` — `Escape` and the close control both
 * cancel without confirming, same as the Cancel button.
 */
export const ConfirmDestructive = forwardRef<HTMLDivElement, ConfirmDestructiveProps>(
  function ConfirmDestructive(
    {
      trigger,
      defaultOpen = false,
      onOpenChange,
      title,
      consequence,
      cancelLabel,
      confirmLabel,
      closeLabel,
      onConfirm,
      loading = false,
      requireTypedConfirmation,
      confirmationValue,
      confirmationLabel,
      returnFocusTo,
      container,
      initialFocus,
    },
    ref
  ) {
    const [open, setOpen] = useState(defaultOpen)
    const [typed, setTyped] = useState('')

    const changeOpen = (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
      if (!next) {
        // The next person to open this dialog starts from nothing typed, not
        // from whatever the last one left behind.
        setTyped('')
      }
    }

    const confirmDisabled = requireTypedConfirmation === true && typed !== confirmationValue

    const handleConfirm = () => {
      onConfirm()
      changeOpen(false)
    }

    return (
      <Dialog
        ref={ref}
        open={open}
        onOpenChange={changeOpen}
        trigger={trigger}
        {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
        {...(container === undefined ? {} : { container })}
        {...(initialFocus === undefined ? {} : { initialFocus })}
        size="sm"
        title={title}
        description={consequence}
        closeLabel={closeLabel}
        footer={
          <>
            <Button variant="secondary" onClick={() => changeOpen(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant="destructive"
              loading={loading}
              disabled={confirmDisabled}
              onClick={handleConfirm}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {requireTypedConfirmation === true ? (
          <TextField
            label={confirmationLabel}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        ) : null}
      </Dialog>
    )
  }
)

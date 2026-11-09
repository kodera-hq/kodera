import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cx } from '../cx'

export interface FieldErrorProps extends Omit<HTMLAttributes<HTMLParagraphElement>, 'children'> {
  /**
   * What went wrong AND how to fix it — the caller's message-catalogue string,
   * never a raw "invalide". `undefined` or `''` renders nothing: a field with
   * nothing to say has no error line, not an empty one.
   */
  children?: string
}

/**
 * The error line every non-`TextField` field in this unit renders for itself —
 * `Select`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `FileDrop`. `role="alert"`
 * because these errors mostly appear after a submit the person is no longer
 * inside the field for (`Form`'s focus-the-first-invalid-field lands them on
 * the control, and the alert is what tells them why before they even look).
 *
 * `TextField` keeps its own inline error paragraph without this role — a
 * foundation decision (`src/ui/TextField/TextField.tsx`) that a message
 * discovered by reaching the field via `aria-describedby` should not also
 * interrupt with a live-region announcement. That primitive is out of this
 * unit's scope to change, so the two error lines read differently on purpose:
 * TextField's error is found, this one is announced.
 */
export const FieldError = forwardRef<HTMLParagraphElement, FieldErrorProps>(function FieldError(
  { children, className, ...rest },
  ref
) {
  if (children === undefined || children === '') return null

  return (
    // `{...rest}` first, `role` after: `HTMLAttributes` makes `role` a valid
    // prop on this component, and a caller passing one — by mistake, or
    // copying a prop bag from elsewhere — must not be able to silence the
    // announcement this primitive exists to make.
    <p {...rest} ref={ref} role="alert" className={cx('text-xs text-c-bad-ink', className)}>
      {children}
    </p>
  )
})

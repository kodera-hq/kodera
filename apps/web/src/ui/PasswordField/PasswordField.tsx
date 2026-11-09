import { forwardRef, useState } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import type { TextFieldProps } from '../TextField/TextField'
import { TextField } from '../TextField/TextField'

export interface PasswordFieldProps extends Omit<TextFieldProps, 'type' | 'action'> {
  /** Accessible name for the reveal toggle while the value is hidden. */
  showLabel: string
  /** Accessible name for the reveal toggle while the value is shown. */
  hideLabel: string
}

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" strokeWidth="1.4" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        d="M1.5 1.5l13 13M6.4 6.6a2 2 0 0 0 2.9 2.9M8 3c4.5 0 7 5 7 5a12.5 12.5 0 0 1-2.3 2.9M4.3 4.3A12.4 12.4 0 0 0 1 8s2.5 5 7 5c.9 0 1.7-.2 2.5-.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * `TextField`, composed through its `action` slot rather than a second copy of
 * its wrapper/label/help/error layout: the reveal toggle is exactly the
 * focusable, non-`aria-hidden` control that slot exists for
 * (`src/ui/TextField/TextField.tsx`), unlike `suffix`, which stays inert text.
 *
 * Keyboard: `Tab` reaches the field, then the toggle; `Enter` and `Space` on
 * the toggle switch the value between hidden and shown without moving focus
 * off it. `aria-pressed` carries the state; the label itself changes between
 * `showLabel` and `hideLabel` so the name spoken already says what pressing it
 * does next, rather than leaving that to `aria-pressed` alone.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(
    { error, showLabel, hideLabel, autoComplete = 'current-password', disabled, ...rest },
    ref
  ) {
    const [visible, setVisible] = useState(false)
    const isDisabled = disabled ?? false

    return (
      <TextField
        {...rest}
        ref={ref}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        disabled={isDisabled}
        {...(error === undefined ? {} : { error })}
        // `{...rest}` above may itself carry a caller's own `aria-invalid`
        // (part of `InputHTMLAttributes`, hence of `TextFieldProps`) — and
        // `TextField` spreads its own `...rest` last on the `<input>`, so a
        // stray one would otherwise win over the invalid state `error` sets.
        // Placed after `{...rest}` here, this is the one place that
        // guarantee is re-asserted, the same shape `TextField`'s own tests
        // do not need because nothing there re-spreads a second time.
        aria-invalid={error === undefined ? undefined : true}
        action={
          <button
            type="button"
            disabled={isDisabled}
            aria-pressed={visible}
            aria-label={visible ? hideLabel : showLabel}
            onClick={() => setVisible((current) => !current)}
            className={cx(
              'flex items-center border-l border-c-border px-3 text-c-ink-3',
              'transition-colors duration-fast ease-out hover:text-c-ink',
              'outline-hidden focus-visible:ring',
              'disabled:cursor-not-allowed disabled:text-c-ink-3',
              TOUCH_TARGET
            )}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        }
      />
    )
  }
)

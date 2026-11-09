import { forwardRef } from 'react'
import type { TextFieldProps } from '../TextField/TextField'
import { TextField } from '../TextField/TextField'

export type EmailFieldProps = Omit<TextFieldProps, 'type' | 'inputMode'>

/**
 * `TextField`, typed and completed for an email address: `type="email"` gets
 * the platform's email keyboard on a touch device, and `autoComplete="email"`
 * is the sane default — a caller building a login form that asks for an email
 * used as the username overrides it with `autoComplete="username"`.
 *
 * Everything else — `label`, `help`, `error`, `suffix`, keyboard behaviour — is
 * `TextField`'s, unchanged; this is a thin wrapper, not a second primitive.
 */
export const EmailField = forwardRef<HTMLInputElement, EmailFieldProps>(function EmailField(
  { autoComplete = 'email', ...rest },
  ref
) {
  // `{...rest}` first, `type`/`inputMode` after: `EmailFieldProps` omits both
  // from its type, but a caller reaching past that (a spread prop bag from
  // elsewhere, say) must not be able to turn this back into a plain text
  // field — the email keyboard and the `type="email"` semantics are the one
  // thing this wrapper exists to guarantee.
  return (
    <TextField {...rest} ref={ref} type="email" inputMode="email" autoComplete={autoComplete} />
  )
})

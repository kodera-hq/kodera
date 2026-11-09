import { forwardRef } from 'react'
import type { Ref, RefCallback } from 'react'
import { useFormContext } from 'react-hook-form'
import type { TextFieldProps } from '../TextField/TextField'
import { TextField } from '../TextField/TextField'

export interface FormFieldProps extends Omit<TextFieldProps, 'error' | 'name' | 'defaultValue'> {
  /** Dot path into the form's values — `'email'`, `'billing.address.city'`. */
  name: string
}

/**
 * Reads a dot path out of react-hook-form's `FieldErrors`, the way
 * `formState.errors.billing.address.city` would if TypeScript's index
 * signature let a runtime string do it. A message is read at the exact
 * segment where it is set — react-hook-form does not put one on every
 * ancestor of a nested field — so this walks the path and stops as soon as it
 * finds a `message`, rather than requiring one at the leaf specifically.
 */
function errorMessageAt(errors: unknown, path: string): string | undefined {
  const segments = path.split('.')
  let current: unknown = errors

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
    if (
      current !== null &&
      typeof current === 'object' &&
      'message' in current &&
      typeof (current as { message?: unknown }).message === 'string'
    ) {
      return (current as { message: string }).message
    }
  }

  return undefined
}

/**
 * `register(name)`'s own `ref` is not optional: it is how `handleSubmit`'s
 * `shouldFocusError` reaches this exact field. A caller's forwarded ref (a
 * screen imperatively focusing a field outside a failed submit, say) must
 * reach the same node without replacing it — so both run, in whichever order
 * they were given.
 */
function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (ref == null) continue
      if (typeof ref === 'function') ref(node)
      else (ref as { current: T | null }).current = node
    }
  }
}

/**
 * `TextField`, wired to a `Form`'s state: `register(name)` supplies
 * `onChange` / `onBlur` / `name` / `ref` — the `ref` is what lets
 * `handleSubmit`'s `shouldFocusError` reach the field — and the error at
 * `name` becomes `TextField`'s `error` prop, which is what sets
 * `aria-invalid` there. Everything else — `label`, `help`, `suffix`, sizing,
 * keyboard behaviour — is `TextField`'s, unchanged.
 *
 * Must render inside a `Form` (or any `FormProvider`): `useFormContext`
 * throws otherwise, which is the loud failure a silently-inert field would
 * not be.
 */
export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField(
  { name, ...rest },
  ref
) {
  const { register, formState } = useFormContext()
  const message = errorMessageAt(formState.errors, name)
  const { ref: registerRef, ...registration } = register(name)

  return (
    <TextField
      {...rest}
      {...registration}
      ref={mergeRefs(registerRef, ref)}
      {...(message === undefined ? {} : { error: message })}
    />
  )
})

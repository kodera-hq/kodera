import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { forwardRef, useId } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'
import { FieldError } from '../FieldError/FieldError'

export interface CheckboxProps {
  label: string
  help?: string
  error?: string
  checked?: boolean | 'indeterminate'
  defaultChecked?: boolean | 'indeterminate'
  onCheckedChange?: (checked: boolean | 'indeterminate') => void
  disabled?: boolean
  name?: string
  value?: string
  id?: string
  className?: string
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IndeterminateIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M3 8h10" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Keyboard: `Tab` reaches it, `Space` toggles it — `Enter` does not, which is
 * the native checkbox behaviour Radix keeps, so it does not double as a form
 * submit the way a `Button` guards against on purpose.
 *
 * 18 px and 4 px radius (COMPONENTS.md) are arbitrary Tailwind values, not
 * tokens: they are exact control dimensions the design of record sets with no
 * equivalent in the spacing or radius scale, the same shape of exception
 * `Button`'s destructive border already records. Neither is a colour, so the
 * token guard (`tests/unit/ui/tokens.test.ts`) has nothing to say about them.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    label,
    help,
    error,
    checked,
    defaultChecked,
    onCheckedChange,
    disabled = false,
    name,
    value,
    id,
    className,
  },
  ref
) {
  const generatedId = useId()
  const checkboxId = id ?? generatedId
  const helpId = `${checkboxId}-help`
  const errorId = `${checkboxId}-error`
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId
  )

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className={cx('flex items-center gap-2', TOUCH_TARGET_HEIGHT)}>
        <CheckboxPrimitive.Root
          ref={ref}
          id={checkboxId}
          {...(checked === undefined ? {} : { checked })}
          {...(defaultChecked === undefined ? {} : { defaultChecked })}
          {...(onCheckedChange === undefined ? {} : { onCheckedChange })}
          {...(name === undefined ? {} : { name })}
          {...(value === undefined ? {} : { value })}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cx(
            // `group` so the two icons below can read this element's own
            // `data-state` — the resolved checked/unchecked/indeterminate
            // state Radix computes, controlled or not, rather than branching
            // in JS on the `checked` prop, which does not exist when the
            // caller uses `defaultChecked` instead.
            'group flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border bg-c-surface',
            // In the narrow layout the box answers a 44 px touch around it (13 px on
            // each side of 18); the label beside it already toggles it too.
            'narrow:relative narrow:before:absolute narrow:before:-inset-[13px]',
            'outline-hidden transition-colors duration-fast ease-out focus-visible:ring',
            // The ring stands 2 px off the box, over the ground (`focus-offset`,
            // `src/index.css`): flush, it met the `ink-4` edge at 2.23 : 1 and
            // the checked `action` fill at 1.20 : 1 in light.
            'focus-offset focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error === undefined ? 'border-c-border-input' : 'border-c-bad-ink',
            'data-[state=checked]:border-c-accent-ink data-[state=checked]:bg-c-action',
            'data-[state=indeterminate]:border-c-accent-ink data-[state=indeterminate]:bg-c-action'
          )}
        >
          <CheckboxPrimitive.Indicator className="text-c-on-inverse">
            <span className="group-data-[state=indeterminate]:hidden">
              <CheckIcon />
            </span>
            <span className="hidden group-data-[state=indeterminate]:block">
              <IndeterminateIcon />
            </span>
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <label htmlFor={checkboxId} className="text-sm text-c-ink">
          {label}
        </label>
      </div>

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
})

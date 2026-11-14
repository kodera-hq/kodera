import * as SwitchPrimitive from '@radix-ui/react-switch'
import { forwardRef, useId } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'
import { FieldError } from '../FieldError/FieldError'

export interface SwitchProps {
  label: string
  help?: string
  error?: string
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  name?: string
  value?: string
  id?: string
  className?: string
}

/**
 * Keyboard: `Tab` reaches it, `Space` toggles it — `Enter` does not, same as
 * `Checkbox`, for the same reason.
 *
 * 34×20 (COMPONENTS.md) is not on the spacing scale in one dimension: the
 * height is `h-5` (the preset's 20 px step), the 34 px width is an arbitrary
 * Tailwind value with no scale equivalent, the same shape of exception
 * `Button`'s destructive border already records — not a colour, so the token
 * guard has nothing to say about it.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
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
  const switchId = id ?? generatedId
  const helpId = `${switchId}-help`
  const errorId = `${switchId}-error`
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId
  )

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className={cx('flex items-center gap-2', TOUCH_TARGET_HEIGHT)}>
        <SwitchPrimitive.Root
          ref={ref}
          id={switchId}
          {...(checked === undefined ? {} : { checked })}
          {...(defaultChecked === undefined ? {} : { defaultChecked })}
          {...(onCheckedChange === undefined ? {} : { onCheckedChange })}
          {...(name === undefined ? {} : { name })}
          {...(value === undefined ? {} : { value })}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cx(
            'relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full border border-transparent',
            'before:absolute before:-inset-y-[2px] before:inset-x-0 narrow:before:-inset-y-[12px] narrow:before:-inset-x-[5px]',
            'bg-c-border-strong outline-hidden transition-colors duration-fast ease-out focus-visible:ring',
            // The ring stands 2 px off the track, over the ground (`focus-offset`,
            // `src/index.css`): flush, it met the checked `action` fill at
            // 1.20 : 1 in light.
            'focus-offset focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'data-[state=checked]:bg-c-action'
          )}
        >
          <SwitchPrimitive.Thumb
            className={cx(
              // `translate-x-[2px]`, not the rem-scale `translate-x-0.5`: the
              // 34×20 pill (COMPONENTS.md) is off the spacing grid already
              // (see the note above), and mixing a rem-scale key into a travel
              // distance that is otherwise exact in pixels would make the two
              // ends of this one movement round differently.
              'block h-4 w-4 translate-x-[2px] rounded-full bg-c-surface shadow-card shadow-c-shadow-1',
              'transition-transform duration-fast ease-out',
              'data-[state=checked]:translate-x-[16px]'
            )}
          />
        </SwitchPrimitive.Root>
        <label htmlFor={switchId} className="text-sm text-c-ink">
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

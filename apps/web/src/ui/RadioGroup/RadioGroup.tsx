import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { forwardRef, useId } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'
import { FieldError } from '../FieldError/FieldError'

export interface RadioOption {
  value: string
  label: string
  disabled?: boolean
}

export type RadioGroupOrientation = 'horizontal' | 'vertical'

export interface RadioGroupProps {
  /** The group's own name, read before its options — there is no single
   * control here for a `<label htmlFor>` to point at. */
  label: string
  help?: string
  error?: string
  options: RadioOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  name?: string
  orientation?: RadioGroupOrientation
  id?: string
  className?: string
}

/**
 * One of these — the roving-tabindex sibling to `ButtonGroup`'s "any of
 * these". `Tab` reaches the group once, landing on the checked option or the
 * first one; `ArrowDown` / `ArrowRight` move to and choose the next option,
 * `ArrowUp` / `ArrowLeft` the previous one; there is no separate "select" key,
 * moving the roving focus is choosing.
 *
 * 16 px options and the 5 px selected ring (COMPONENTS.md) are arbitrary
 * Tailwind values, not tokens — exact control dimensions with no scale
 * equivalent, the same shape of exception `Button`'s destructive border
 * already records. Neither is a colour, so the token guard has nothing to
 * say about them.
 */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    label,
    help,
    error,
    options,
    value,
    defaultValue,
    onValueChange,
    disabled = false,
    name,
    orientation = 'vertical',
    id,
    className,
  },
  ref
) {
  const generatedId = useId()
  const groupId = id ?? generatedId
  const helpId = `${groupId}-help`
  const errorId = `${groupId}-error`
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId
  )

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <span className="text-sm font-medium text-c-ink">{label}</span>

      <RadioGroupPrimitive.Root
        ref={ref}
        id={groupId}
        aria-label={label}
        {...(value === undefined ? {} : { value })}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(onValueChange === undefined ? {} : { onValueChange })}
        {...(name === undefined ? {} : { name })}
        disabled={disabled}
        orientation={orientation}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className={cx('flex', orientation === 'horizontal' ? 'flex-row gap-4' : 'flex-col gap-2')}
      >
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`
          return (
            <div key={option.value} className={cx('flex items-center gap-2', TOUCH_TARGET_HEIGHT)}>
              <RadioGroupPrimitive.Item
                id={optionId}
                value={option.value}
                disabled={option.disabled ?? false}
                className={cx(
                  'group flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-c-surface',
                  // In the narrow layout the dot answers a 44 px touch around it (14 px
                  // on each side of 16); its label toggles it too.
                  'narrow:relative narrow:before:absolute narrow:before:-inset-[14px]',
                  'outline-hidden transition-colors duration-fast ease-out focus-visible:ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  error === undefined ? 'border-c-border-input' : 'border-c-bad-ink',
                  'data-[state=checked]:border-c-accent-ink data-[state=checked]:ring-control-selection data-[state=checked]:ring-c-accent-soft',
                  // The checked halo sets the ring colour, so a focus ring on
                  // the checked radio drew in `accent-soft`, about 1.2 : 1 on
                  // the surface. Focus gets its own colour in both states; the
                  // stacked variant sorts after the halo and wins.
                  'focus-visible:ring-c-accent-ink data-[state=checked]:focus-visible:ring-c-accent-ink'
                )}
              >
                <RadioGroupPrimitive.Indicator className="h-2 w-2 rounded-full bg-c-accent-ink" />
              </RadioGroupPrimitive.Item>
              <label
                htmlFor={optionId}
                className={cx('text-sm text-c-ink', option.disabled === true && 'opacity-50')}
              >
                {option.label}
              </label>
            </div>
          )
        })}
      </RadioGroupPrimitive.Root>

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
})

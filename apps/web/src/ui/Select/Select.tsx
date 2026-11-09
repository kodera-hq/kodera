import * as SelectPrimitive from '@radix-ui/react-select'
import { forwardRef, useId } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'
import { FieldError } from '../FieldError/FieldError'

/** Mirrors `TextField`'s — no `sm` here either, for the same reason. */
export type SelectSize = 'md' | 'lg'

const SIZE: Record<SelectSize, string> = {
  md: 'h-10',
  lg: 'h-12',
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  label: string
  help?: string
  error?: string
  placeholder?: string
  options: SelectOption[]
  size?: SelectSize
  disabled?: boolean
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  id?: string
  className?: string
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor">
      <path d="M4 6l4 4 4-4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor">
      <path d="M3 8.5l3 3 7-7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * A closed list, chosen from — Radix's own name is `Select`; ours keeps it,
 * `Combobox` is the sibling primitive for a list filtered by typing.
 *
 * Keyboard (from Radix, unmodified): `Space`, `Enter` or `ArrowDown` open it;
 * typing a letter jumps to the next option starting with it; `ArrowUp` /
 * `ArrowDown` move the highlighted option; `Enter` chooses it; `Escape` closes
 * without choosing.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    help,
    error,
    placeholder,
    options,
    size = 'md',
    disabled = false,
    name,
    value,
    defaultValue,
    onValueChange,
    id,
    className,
  },
  ref
) {
  const generatedId = useId()
  const triggerId = id ?? generatedId
  const helpId = `${triggerId}-help`
  const errorId = `${triggerId}-error`
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId
  )

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={triggerId} className="text-sm font-medium text-c-ink">
        {label}
      </label>

      <SelectPrimitive.Root
        {...(name === undefined ? {} : { name })}
        {...(value === undefined ? {} : { value })}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(onValueChange === undefined ? {} : { onValueChange })}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          ref={ref}
          id={triggerId}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cx(
            'flex items-center justify-between gap-2 rounded-sm border px-3',
            'text-md outline-hidden transition-colors duration-fast ease-out',
            'focus-visible:ring',
            'data-[disabled]:cursor-not-allowed',
            // Unavailable: the `disabled` pair, not half opacity (see `TextField`).
            disabled === true
              ? 'border-c-border bg-c-disabled text-c-on-disabled'
              : cx(
                  'bg-c-surface text-c-ink data-[placeholder]:text-c-placeholder',
                  error === undefined
                    ? 'border-c-border-input focus-visible:border-c-accent-ink'
                    : 'border-c-bad-ink'
                ),
            SIZE[size],
            TOUCH_TARGET_HEIGHT
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon
            aria-hidden="true"
            className={cx('shrink-0', disabled === true ? 'text-c-on-disabled' : 'text-c-ink-3')}
          >
            <ChevronIcon />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>

        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            // `max-h-[256px]`: an arbitrary value, not a token — the preset's
            // spacing scale stops at `12` (48 px) and has no step this large.
            // Not a colour either, so the token guard has nothing to say.
            className="z-50 max-h-[256px] overflow-hidden rounded-sm border border-c-border bg-c-elevated shadow-pop shadow-c-shadow-2"
          >
            <SelectPrimitive.Viewport className="p-1">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled ?? false}
                  className={cx(
                    'flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-2',
                    TOUCH_TARGET_HEIGHT,
                    'text-md text-c-ink outline-hidden',
                    'data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink',
                    'data-[highlighted]:ring-1 data-[highlighted]:ring-c-accent-ink data-[highlighted]:ring-inset',
                    'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'
                  )}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator aria-hidden="true">
                    <CheckIcon />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
})

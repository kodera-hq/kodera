import * as PopoverPrimitive from '@radix-ui/react-popover'
import { forwardRef, useId, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'
import { FieldError } from '../FieldError/FieldError'

/** Mirrors `TextField`'s — no `sm` here either, for the same reason. */
export type ComboboxSize = 'md' | 'lg'

const SIZE: Record<ComboboxSize, string> = {
  md: 'h-10',
  lg: 'h-12',
}

export interface ComboboxOption {
  value: string
  label: string
  disabled?: boolean
}

export interface ComboboxProps {
  label: string
  help?: string
  error?: string
  placeholder?: string
  options: ComboboxOption[]
  /** Shown in place of the list when the typed text matches nothing. */
  emptyText: string
  size?: ComboboxSize
  disabled?: boolean
  name?: string
  value?: string
  onValueChange?: (value: string | undefined) => void
  id?: string
  className?: string
}

function optionId(listboxId: string, value: string) {
  return `${listboxId}-option-${value}`
}

/**
 * A list filtered by typing — the ARIA 1.2 combobox pattern, built directly on
 * `Popover` rather than on `Select`: `Select`'s trigger is a button that opens
 * a fixed list, and there is no native "and also accepts what you type" mode to
 * turn on. Focus never leaves the input, which is the pattern's central rule —
 * `Popover.Content`'s own auto-focus is switched off on open and on close so it
 * cannot violate that.
 *
 * Keyboard: `ArrowDown` opens the list if closed, then moves the highlighted
 * option down; `ArrowUp` moves it up; `Home` / `End` jump to the first / last
 * option the current filter leaves enabled; `Enter` chooses the highlighted
 * option, fills the field with its label and closes the list; `Escape` closes
 * without choosing. Typing filters the list case-insensitively on the label and
 * re-opens it.
 */
export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
  {
    label,
    help,
    error,
    placeholder,
    options,
    emptyText,
    size = 'md',
    disabled = false,
    name,
    value,
    onValueChange,
    id,
    className,
  },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const listboxId = `${inputId}-listbox`
  const helpId = `${inputId}-help`
  const errorId = `${inputId}-error`
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId
  )

  const selected = useMemo(() => options.find((option) => option.value === value), [options, value])

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(selected?.label ?? '')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter((option) => option.label.toLowerCase().includes(needle))
  }, [options, query])

  const enabledIndexes = useMemo(
    () => filtered.flatMap((option, index) => (option.disabled === true ? [] : [index])),
    [filtered]
  )

  function openWithHighlight(index: number | null) {
    setOpen(true)
    setActiveIndex(index)
  }

  function selectOption(option: ComboboxOption) {
    setQuery(option.label)
    setOpen(false)
    setActiveIndex(null)
    onValueChange?.(option.value)
  }

  function handleChange(nextQuery: string) {
    setQuery(nextQuery)
    setOpen(true)
    setActiveIndex(null)
    if (selected !== undefined && nextQuery !== selected.label) {
      onValueChange?.(undefined)
    }
  }

  function moveHighlight(direction: 1 | -1) {
    if (enabledIndexes.length === 0) return
    if (!open) {
      openWithHighlight(
        direction === 1 ? (enabledIndexes[0] ?? null) : (enabledIndexes.at(-1) ?? null)
      )
      return
    }
    const currentPosition = activeIndex === null ? -1 : enabledIndexes.indexOf(activeIndex)
    const nextPosition =
      currentPosition === -1
        ? direction === 1
          ? 0
          : enabledIndexes.length - 1
        : Math.min(Math.max(currentPosition + direction, 0), enabledIndexes.length - 1)
    setActiveIndex(enabledIndexes[nextPosition] ?? null)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveHighlight(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveHighlight(-1)
        return
      case 'Home':
        if (!open || enabledIndexes.length === 0) return
        event.preventDefault()
        setActiveIndex(enabledIndexes[0] ?? null)
        return
      case 'End':
        if (!open || enabledIndexes.length === 0) return
        event.preventDefault()
        setActiveIndex(enabledIndexes.at(-1) ?? null)
        return
      case 'Enter': {
        if (!open || activeIndex === null) return
        event.preventDefault()
        const option = filtered[activeIndex]
        if (option !== undefined) selectOption(option)
        return
      }
      case 'Escape':
        if (!open) return
        setOpen(false)
        setActiveIndex(null)
        return
      default:
        return
    }
  }

  const activeDescendant =
    open && activeIndex !== null
      ? optionId(listboxId, filtered[activeIndex]?.value ?? '')
      : undefined

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-c-ink">
        {label}
      </label>

      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Anchor asChild>
          <div
            className={cx(
              'flex items-stretch overflow-hidden rounded-sm border',
              'transition-colors duration-fast ease-out',
              'focus-within:ring',
              // Unavailable: the `disabled` pair, not half opacity (see `TextField`).
              disabled === true
                ? 'border-c-border bg-c-disabled'
                : error === undefined
                  ? 'border-c-border-input bg-c-surface focus-within:border-c-accent-ink'
                  : 'border-c-bad-ink bg-c-surface'
            )}
          >
            <input
              ref={ref}
              id={inputId}
              name={name}
              role="combobox"
              autoComplete="off"
              placeholder={placeholder}
              disabled={disabled}
              value={query}
              aria-expanded={open}
              // Only while open: `Popover.Content` (and the `listboxId` it
              // carries) is not mounted when closed, and a reference to an
              // absent id is worse than none — Radix's own `Select` trigger
              // makes the same choice for its `aria-controls`. The attribute
              // name stays literal (rather than a conditional spread) so the
              // `role="combobox"` a11y lint rule can still see it declared.
              aria-controls={open ? listboxId : undefined}
              aria-autocomplete="list"
              {...(activeDescendant === undefined
                ? {}
                : { 'aria-activedescendant': activeDescendant })}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={describedBy === '' ? undefined : describedBy}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onChange={(event) => handleChange(event.target.value)}
              onKeyDown={handleKeyDown}
              className={cx(
                'min-w-0 flex-1 bg-transparent px-3 text-md outline-hidden',
                disabled === true
                  ? 'text-c-on-disabled placeholder:text-c-on-disabled'
                  : 'text-c-ink placeholder:text-c-placeholder',
                'disabled:cursor-not-allowed',
                SIZE[size],
                TOUCH_TARGET_HEIGHT
              )}
            />
          </div>
        </PopoverPrimitive.Anchor>

        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            // The input is an Anchor, not a Trigger. Its own interaction
            // must not dismiss the portalled list that it just opened.
            onInteractOutside={(event) => {
              if (event.target instanceof HTMLElement && event.target.id === inputId) {
                event.preventDefault()
              }
            }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            sideOffset={4}
            // `max-h-[256px]`: an arbitrary value, not a token — the preset's
            // spacing scale stops at `12` (48 px) and has no step this large.
            // Not a colour either, so the token guard has nothing to say.
            // The input's width, which Radix publishes on the content as a custom property.
            className="z-50 max-h-[256px] w-(--radix-popover-trigger-width) overflow-auto rounded-sm border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2"
          >
            <ul id={listboxId} role="listbox" aria-label={label}>
              {filtered.length === 0 ? (
                <li className="px-2 py-2 text-sm text-c-ink-3">{emptyText}</li>
              ) : (
                filtered.map((option, index) => (
                  // Keyboard selection is already handled on the input above
                  // (ArrowUp/Down move the highlight, Enter chooses it); this
                  // `onClick` is the pointer path onto the same `selectOption`
                  // call, not a second, keyboard-inaccessible way to reach it.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={option.value}
                    id={optionId(listboxId, option.value)}
                    role="option"
                    aria-selected={option.value === selected?.value}
                    aria-disabled={option.disabled === true ? true : undefined}
                    data-highlighted={index === activeIndex ? '' : undefined}
                    // Keeps focus on the input: without this the browser's
                    // default mousedown behaviour moves focus to the option
                    // before `click` fires, which is exactly what the combobox
                    // pattern forbids.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => option.disabled !== true && selectOption(option)}
                    className={cx(
                      'flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-2',
                      TOUCH_TARGET_HEIGHT,
                      'text-md text-c-ink outline-hidden',
                      'data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink',
                      'data-[highlighted]:ring-1 data-[highlighted]:ring-c-accent-ink data-[highlighted]:ring-inset',
                      option.disabled === true && 'cursor-not-allowed opacity-50'
                    )}
                  >
                    {option.label}
                  </li>
                ))
              )}
            </ul>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
})

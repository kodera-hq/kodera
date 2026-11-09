import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

/**
 * No `sm`. COMPONENTS.md sanctions the 32 px control for `Button` alone: a
 * field is a hit target you aim at with a caret and re-read what you typed in,
 * and 32 px is below the 40 px minimum the design of record sets for those.
 * Add a step here only by changing that document first.
 */
export type TextFieldSize = 'md' | 'lg'

const SIZE: Record<TextFieldSize, string> = {
  md: 'h-10',
  lg: 'h-12',
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /**
   * Visible, always, and above the control (COMPONENTS.md). A placeholder is
   * not a label: it disappears the moment someone types, so the field loses its
   * name exactly when a person is checking what they entered.
   */
  label: string
  /** Standing guidance, read out with the field. */
  help?: string
  /**
   * What went wrong AND how to fix it — "essayez « acme-construction »", never
   * "invalide". Comes from the caller's message catalogue; a primitive holds no
   * string a customer reads.
   */
  error?: string
  /**
   * A muted block after the control, e.g. `.visio.kodera.io`. It is read out
   * with the field, because it is usually part of the value being composed:
   * hidden, the field announces "acme" while the screen reads
   * "acme.visio.kodera.io" and nobody can tell who is supposed to type the
   * rest. Pass `decorative` for the ones that genuinely say nothing.
   *
   * It is not an action. A "Copy" button next to a read-only value is a
   * `Button` beside the field, not a suffix inside it — a suffix is not
   * focusable and cannot be reached by a keyboard.
   */
  suffix?: ReactNode
  /** Hide the suffix from assistive technology: a repeated unit, an icon that
   * restates the label. Silence by decision, not by default. */
  decorative?: boolean
  /**
   * Focusable content after the control, inside the same bordered frame and
   * sharing its `focus-within:ring` — a password field's reveal toggle, a
   * copy button that needs the value it copies right next to it. Unlike
   * `suffix`, which is inert text folded into the field's own accessible
   * description, this is a second control with its own accessible name
   * (never `aria-hidden`): reached by `Tab` right after the input, same as
   * any control placed beside it. The caller supplies its own styling — a
   * left border, padding, hover state — same as `suffix`'s span does not.
   */
  action?: ReactNode
  size?: TextFieldSize
}

/**
 * Keyboard: `Tab` moves to the control, typing edits it, and clicking the label
 * focuses it (the label is bound with `htmlFor`, not wrapped, so a suffix can
 * sit outside the hit area without stealing the click). An `action` is reached
 * by `Tab` right after the input — it is a real control, unlike `suffix`.
 *
 * The error is wired with `aria-describedby` and `aria-invalid` rather than
 * announced through a live region: the message is read when the field is
 * reached, which is where someone can act on it, and a form that turns every
 * blur into an interruption is unusable with a screen reader.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    help,
    error,
    suffix,
    decorative = false,
    action,
    size = 'md',
    id,
    className,
    disabled,
    readOnly,
    ...rest
  },
  ref
) {
  // `useId` rather than a counter: two fields with the same generated id make
  // both labels point at the first one, and nothing anywhere fails.
  const generatedId = useId()
  const inputId = id ?? generatedId
  const helpId = `${inputId}-help`
  const errorId = `${inputId}-error`
  const suffixId = `${inputId}-suffix`
  const announcesSuffix = suffix !== undefined && !decorative
  // Order is reading order: the standing guidance, then what went wrong, then
  // the tail of the value. The error last would be the thing a person hears
  // first only if they were already at the end of the field.
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined ? undefined : errorId,
    announcesSuffix ? suffixId : undefined
  )

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-c-ink">
        {label}
      </label>

      <div
        className={cx(
          'flex items-stretch overflow-hidden rounded-sm border',
          'transition-colors duration-fast ease-out',
          // The ring is on the wrapper, not the control: with a suffix the two
          // are one field to look at, and a ring drawn around half of it reads
          // as a different widget.
          'focus-within:ring',
          // Unavailable: the `disabled` fill and `on-disabled` text (tokens v0.2.0, 4.5 : 1 in
          // every theme) instead of half opacity, whose contrast is whatever the ground makes it.
          // The edge becomes the decorative `border`, so the field keeps its shape.
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
          disabled={disabled ?? false}
          readOnly={readOnly ?? false}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cx(
            'min-w-0 flex-1 bg-transparent px-3 text-md outline-hidden',
            // `:read-only` also matches a disabled input, so the muted read-only
            // ground is only for a field that is read-only and still available.
            disabled === true
              ? 'text-c-on-disabled placeholder:text-c-on-disabled'
              : 'text-c-ink placeholder:text-c-placeholder read-only:bg-c-muted',
            'disabled:cursor-not-allowed',
            SIZE[size],
            TOUCH_TARGET_HEIGHT
          )}
          {...rest}
        />
        {suffix === undefined ? null : (
          <span
            id={announcesSuffix ? suffixId : undefined}
            aria-hidden={announcesSuffix ? undefined : true}
            className={cx(
              'flex items-center border-l border-c-border px-3 font-mono text-sm',
              disabled === true ? 'bg-c-disabled text-c-on-disabled' : 'bg-c-muted text-c-ink-3'
            )}
          >
            {suffix}
          </span>
        )}
        {action === undefined ? null : action}
      </div>

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-c-bad-ink">
          {error}
        </p>
      )}
    </div>
  )
})

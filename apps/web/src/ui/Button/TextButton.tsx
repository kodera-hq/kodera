import { Slot } from '@radix-ui/react-slot'
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react'
import { Spinner } from '../Spinner/Spinner'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { LINK_TEXT } from '../linkText'

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE = cx(
  'relative inline-flex items-center justify-center whitespace-nowrap rounded-md font-semibold',
  'text-md transition-colors duration-fast ease-out',
  // The focus ring is on every interactive element (DESIGN_SYSTEM.md §2, and
  // WCAG 2.4.7). `focus-visible`, not `focus`: a ring drawn on every mouse
  // click trains people to ignore it. `outline-hidden` is safe only because the
  // ring replaces it on the same event — dropping the ring would leave a
  // keyboard user with nothing at all.
  'focus-visible:outline-hidden focus-visible:ring',
  TOUCH_TARGET
)

// A button box draws its ring 2 px outside itself, with the gap painted in the
// ground it sits on (`focus-offset`, `src/index.css`), so the ring's neighbours
// are that ground on both sides and never the fill: flush, the light ring was
// 1.20 : 1 against the primary `action` fill and 1.00 against its hover fill.
// Tertiary is text on the ground, with no box, and keeps the plain ring.
const BOX_FOCUS = 'focus-offset focus-visible:ring-offset-2'

/** Appearance while the button can be pressed. */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-c-action text-c-on-inverse hover:bg-c-action-hover',
  secondary: 'border border-c-border-input bg-c-surface text-c-ink hover:bg-c-muted',
  tertiary: LINK_TEXT.standalone,
  // COMPONENTS.md gives this border as a raw light-red value rather than a
  // token name, and the tokens package publishes no step for it. So the border
  // is the danger fill at the opacity that lands on the same colour over white
  // — a token with a modifier, never a value typed in here. Replace it with the
  // real token the moment the tokens repository publishes one.
  destructive: 'border border-red-500/40 bg-c-surface text-c-bad-ink hover:bg-c-bad-soft',
}

/**
 * Appearance while it cannot be pressed — `disabled`, and `loading`, which is
 * not disabled but is not pressable either.
 *
 * Chosen in TypeScript rather than with Tailwind's `disabled:` variant, for two
 * reasons that both come from this file's rules below: `loading` deliberately
 * does not set the native attribute, and the `asChild` element is usually an
 * `<a>`, which has no `:disabled` pseudo-class at all. A state that only some
 * of a primitive's renderings can show is worse than no state.
 *
 * No `hover:` here: an unavailable control that lights up under the pointer is
 * telling the person it will respond.
 */
const VARIANT_INACTIVE: Record<ButtonVariant, string> = {
  // One inactive look for every boxed variant: the neutral `disabled` fill and
  // its `on-disabled` label (4.5 : 1 in every theme, tokens v0.2.0), no edge and
  // no opacity. The secondary button's `border-input` edge (3:1) is what tells
  // them apart; the inactive border stays, transparent, so the width does not
  // move. A faded label would land at whatever contrast the ground made.
  primary: 'bg-c-disabled text-c-on-disabled',
  secondary: 'border border-transparent bg-c-disabled text-c-on-disabled',
  tertiary: 'text-c-ink-4',
  destructive: 'border border-transparent bg-c-disabled text-c-on-disabled',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8',
  md: 'h-10',
  lg: 'h-12',
}

// `iconOnly`: as wide as it is tall, no side padding.
const SQUARE: Record<ButtonSize, string> = {
  sm: 'w-8',
  md: 'w-10',
  lg: 'w-12',
}

export interface BaseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconOnly?: boolean
  asChild?: boolean
}

export type TextButtonProps = Omit<BaseButtonProps, 'iconOnly'> & {
  iconOnly?: never
}

/**
 * Shared button markup without `Tooltip` (`@radix-ui/react-tooltip` + `@floating-ui`), so entry
 * error/callback screens that only draw labelled buttons do not ship positioning libraries before
 * sign-in. `Button` wraps `BaseButton` with `Tooltip` whenever `iconOnly` is set.
 */
export const BaseButton = forwardRef<HTMLButtonElement, BaseButtonProps>(function BaseButton(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    iconOnly = false,
    asChild = false,
    // A `<button>` inside a `<form>` submits by default, which turns every
    // secondary action on a form into an accidental submit. Callers who mean
    // to submit say so.
    type = 'button',
    disabled,
    className,
    children,
    onClick,
    ...rest
  },
  ref
) {
  const isDisabled = disabled === true
  const inactive = isDisabled || loading

  const classes = cx(
    BASE,
    inactive ? VARIANT_INACTIVE[variant] : VARIANT[variant],
    variant !== 'tertiary' && BOX_FOCUS,
    SIZE[size],
    iconOnly ? SQUARE[size] : variant === 'tertiary' ? 'px-3' : 'px-4',
    inactive && 'cursor-not-allowed',
    className
  )

  const suppressActivation = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const dataDisabled = isDisabled ? '' : undefined
  const dataLoading = loading ? '' : undefined

  if (asChild) {
    return (
      <Slot
        {...rest}
        ref={ref as Ref<HTMLElement>}
        className={classes}
        aria-disabled={inactive ? true : undefined}
        data-disabled={dataDisabled}
        data-loading={dataLoading}
        {...(inactive ? { tabIndex: -1 } : {})}
        onClick={inactive ? suppressActivation : onClick}
      >
        {children}
      </Slot>
    )
  }

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      disabled={isDisabled}
      aria-disabled={loading ? true : undefined}
      aria-busy={loading ? true : undefined}
      data-disabled={dataDisabled}
      data-loading={dataLoading}
      onClick={loading ? suppressActivation : onClick}
    >
      <span className={cx('inline-flex items-center gap-2', loading && 'opacity-0')}>
        {icon === undefined ? null : (
          <span aria-hidden="true" className="inline-flex shrink-0">
            {icon}
          </span>
        )}
        {iconOnly ? null : children}
      </span>
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={size === 'lg' ? 'md' : 'sm'} />
        </span>
      ) : null}
    </button>
  )
})

/** Labelled button without `iconOnly`, safe for entry routes outside `/$org`. */
export const TextButton = BaseButton as unknown as ReturnType<
  typeof forwardRef<HTMLButtonElement, TextButtonProps>
>

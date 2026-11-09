import { Slot } from '@radix-ui/react-slot'
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react'
import { Spinner } from '../Spinner/Spinner'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { LINK_TEXT } from '../linkText'
import { Tooltip } from '../Tooltip/Tooltip'

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

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * Replaces the label with a spinner and keeps the button's width, so a row of
   * actions does not reflow the moment one of them is pressed. The label stays
   * in the accessibility tree: the button keeps its name and gains `aria-busy`,
   * which is what a screen reader needs, and disappearing text is not.
   *
   * It does NOT set the native `disabled` attribute. That attribute blurs the
   * element the instant it appears — a keyboard user who pressed the button is
   * dropped back to the top of the document — and it takes the element out of
   * the accessibility tree, which makes `aria-busy` an announcement about
   * something nobody is on. The button stays focusable and marks itself
   * `aria-disabled`; activation is suppressed in the handler below.
   */
  loading?: boolean
  /** Decoration only, hidden from assistive technology. An icon-only button
   * still needs an `aria-label` from the caller's catalogue. */
  icon?: ReactNode
  /**
   * Icons only (owner decision, 2026-11-07): a square holding `icon` and no visible label. `aria-label` is
   * required and is its name, shown as a tooltip on hover and on focus (`Tooltip` with `names`).
   * Children are not drawn. Not with `asChild`.
   */
  iconOnly?: boolean
  /**
   * Render the caller's own element with these classes and props instead of a
   * `<button>` — a router link that has to look like a button. `icon` and
   * `loading` do not apply: the composition they need is more than one child,
   * and a link cannot be busy.
   *
   * `disabled` does apply, and cannot be passed through: an `<a>` ignores the
   * attribute, so a "disabled" link would look unavailable while still
   * navigating and still answering `Tab`. It is expressed instead as
   * `aria-disabled`, `data-disabled`, `tabIndex={-1}` and the same activation
   * guard the loading button uses.
   */
  asChild?: boolean
}

/**
 * Keyboard: `Tab` moves to it, `Enter` and `Space` activate it. A `disabled`
 * button is skipped by `Tab`, which is what the attribute means. A `loading`
 * one is not: it keeps focus and refuses to act, so the person who pressed it
 * is still standing on the thing they are waiting for.
 *
 * One primary per screen (COMPONENTS.md). The label is a verb and an object
 * ("Inviter des personnes"), never "OK" — and it comes from the caller.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
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

  // `Enter` and `Space` on a focused control both arrive here as a click, so
  // one guard covers the pointer and the keyboard. `preventDefault` stops the
  // default action a `type="submit"` button or an `<a href>` would otherwise
  // take, and `stopPropagation` stops the row or card the control sits in from
  // handling a click the control itself refused — which is what the native
  // `disabled` attribute does, and the behaviour callers already expect.
  const suppressActivation = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  // Styling hooks for the states that are not CSS pseudo-classes here, so a
  // later primitive composing a Button can reach them from its own stylesheet.
  const dataDisabled = isDisabled ? '' : undefined
  const dataLoading = loading ? '' : undefined

  const name = rest['aria-label']
  if (
    iconOnly &&
    (asChild || icon == null || icon === false || name === undefined || name.trim() === '')
  ) {
    // An icon with no name is a control nobody using a screen reader can identify; refuse it.
    throw new Error('Button iconOnly needs an icon and an aria-label, and cannot be asChild')
  }

  if (asChild) {
    return (
      // The caller's remaining props go first, so nothing they pass can
      // silently take the unavailable state back off the element.
      <Slot
        {...rest}
        ref={ref as Ref<HTMLElement>}
        className={classes}
        aria-disabled={inactive ? true : undefined}
        data-disabled={dataDisabled}
        data-loading={dataLoading}
        // Out of the tab order rather than out of the document: the element
        // stays announceable, so someone reading the page still learns the
        // action exists and is currently unavailable.
        {...(inactive ? { tabIndex: -1 } : {})}
        onClick={inactive ? suppressActivation : onClick}
      >
        {children}
      </Slot>
    )
  }

  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      // Native `disabled` only for the explicit prop. See `loading` above for
      // why the busy state is not spelled with it.
      disabled={isDisabled}
      // A natively disabled button is already unavailable to everything that
      // reads the tree; repeating it in ARIA says nothing and, on some
      // combinations, is announced twice.
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
  return iconOnly && name !== undefined ? (
    <Tooltip content={name} names>
      {button}
    </Tooltip>
  ) : (
    button
  )
})

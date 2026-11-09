import { Slot } from '@radix-ui/react-slot'
import { forwardRef } from 'react'
import type { AnchorHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react'
import type { ButtonSize, ButtonVariant } from '../Button/Button'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { LINK_TEXT } from '../linkText'

// Duplicated from `Button.tsx` rather than imported: those maps are not
// exported, and re-exporting them would be a change to a foundation file this
// unit is not scoped to touch (`src/ui/README.md`). Four short lines each; if
// the two drift, that is a two-line fix here, not a reason to widen Button's
// surface for one caller.
const BASE = cx(
  'relative inline-flex items-center justify-center whitespace-nowrap rounded-md font-semibold',
  'text-md transition-colors duration-fast ease-out',
  'focus-visible:outline-hidden focus-visible:ring',
  TOUCH_TARGET
)

// A button box draws its ring 2 px outside itself, with the gap painted in the
// ground it sits on (`focus-offset`, `src/index.css`), so the ring's neighbours
// are that ground on both sides and never the fill: flush, the light ring was
// 1.20 : 1 against the primary `action` fill and 1.00 against its hover fill.
// Tertiary is text on the ground, with no box, and keeps the plain ring.
const BOX_FOCUS = 'focus-offset focus-visible:ring-offset-2'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-c-action text-c-on-inverse hover:bg-c-action-hover',
  secondary: 'border border-c-border-input bg-c-surface text-c-ink hover:bg-c-muted',
  tertiary: LINK_TEXT.standalone,
  destructive: 'border border-red-500/40 bg-c-surface text-c-bad-ink hover:bg-c-bad-soft',
}

// The same inactive look as `Button` (see there).
const VARIANT_INACTIVE: Record<ButtonVariant, string> = {
  primary: 'bg-c-disabled text-c-on-disabled',
  secondary: 'border border-transparent bg-c-disabled text-c-on-disabled',
  tertiary: 'text-c-ink-4',
  destructive: 'border border-transparent bg-c-disabled text-c-on-disabled',
}

// A link inside running text: no button box, the sentence's own size, and
// underlined at rest (`LINK_TEXT.inline`). Inactive, it keeps the underline and
// takes the inactive tertiary ink.
const INLINE = 'rounded-sm underline-offset-2 focus-visible:outline-hidden focus-visible:ring'
const INLINE_INACTIVE = 'text-c-ink-4 underline cursor-not-allowed'

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8',
  md: 'h-10',
  lg: 'h-12',
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Decoration only, hidden from assistive technology. An icon-only link
   * still needs an `aria-label` from the caller. */
  icon?: ReactNode
  /**
   * An `<a>` has no `disabled` attribute, so the state is spelled out:
   * `aria-disabled`, `data-disabled`, `tabIndex={-1}` and a click guard —
   * the same shape `Button`'s `asChild` link case uses, for the same reason.
   * Left unset, a "disabled" link would look unavailable while still
   * navigating and still answering `Tab`.
   */
  disabled?: boolean
  /**
   * Render the caller's own element with these classes and props — a router
   * `Link` that has to carry `Button`'s appearance. `icon` does not apply:
   * the composition it needs is more than one child.
   */
  asChild?: boolean
  /**
   * The link sits inside running text. It is drawn as text, not as a button,
   * and is underlined at rest (`LINK_TEXT.inline`): in a sentence, its colour
   * alone would not tell it apart (WCAG 1.4.1). `variant`, `size` and `icon`
   * do not apply. A link that stands on its own leaves this unset and uses
   * `variant="tertiary"`, underlined on hover.
   */
  inline?: boolean
}

/**
 * `Button`, styled the same way, behaving like a link: `Tab` reaches it,
 * `Enter` follows `href`. There is no `Space` activation and no `loading` —
 * neither exists for navigation, which is why this is its own primitive
 * rather than another prop on `Button`.
 *
 * A `target="_blank"` link gets `rel="noopener noreferrer"` unless the caller
 * already set one: without it the opened page keeps a handle on
 * `window.opener`, the reverse-tabnabbing hole `rel` exists to close.
 */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  {
    variant = 'primary',
    size = 'md',
    icon,
    asChild = false,
    disabled = false,
    inline = false,
    className,
    children,
    onClick,
    target,
    rel,
    ...rest
  },
  ref
) {
  const classes = inline
    ? cx(INLINE, disabled ? INLINE_INACTIVE : LINK_TEXT.inline, className)
    : cx(
        BASE,
        disabled ? VARIANT_INACTIVE[variant] : VARIANT[variant],
        variant !== 'tertiary' && BOX_FOCUS,
        SIZE[size],
        variant === 'tertiary' ? 'px-3' : 'px-4',
        disabled && 'cursor-not-allowed',
        className
      )

  const suppressActivation = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const computedRel = target === '_blank' ? (rel ?? 'noopener noreferrer') : rel
  const Comp = asChild ? Slot : 'a'

  return (
    <Comp
      {...rest}
      ref={ref as Ref<HTMLAnchorElement>}
      target={target}
      rel={computedRel}
      className={classes}
      aria-disabled={disabled ? true : undefined}
      data-disabled={disabled ? '' : undefined}
      {...(disabled ? { tabIndex: -1 } : {})}
      onClick={disabled ? suppressActivation : onClick}
    >
      {asChild || inline ? (
        children
      ) : (
        <span className="inline-flex items-center gap-2">
          {icon === undefined ? null : (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {icon}
            </span>
          )}
          {children}
        </span>
      )}
    </Comp>
  )
})

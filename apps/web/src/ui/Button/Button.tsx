import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip } from '../Tooltip/Tooltip'
import { BaseButton, type ButtonSize, type ButtonVariant } from './TextButton'

export type { ButtonSize, ButtonVariant }

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
   * dropped back to the top of the document — and it removes the element from
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
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const { iconOnly = false, asChild = false, icon } = props
  const name = props['aria-label']
  if (
    iconOnly &&
    (asChild || icon == null || icon === false || name === undefined || name.trim() === '')
  ) {
    // An icon with no name is a control nobody using a screen reader can identify; refuse it.
    throw new Error('Button iconOnly needs an icon and an aria-label, and cannot be asChild')
  }
  const button = <BaseButton {...props} ref={ref} />
  return iconOnly && name !== undefined ? (
    <Tooltip content={name} names>
      {button}
    </Tooltip>
  ) : (
    button
  )
})

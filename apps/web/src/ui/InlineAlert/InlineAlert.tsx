import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx'

export type InlineAlertKind = 'info' | 'success' | 'warning' | 'error'

const KIND: Record<InlineAlertKind, string> = {
  info: 'bg-c-accent-soft text-c-accent-ink',
  success: 'bg-c-ok-soft text-c-ok-ink',
  warning: 'bg-c-warn-soft text-c-warn-ink',
  error: 'bg-c-bad-soft text-c-bad-ink',
}

const ROLE: Record<InlineAlertKind, 'status' | 'alert'> = {
  info: 'status',
  success: 'status',
  warning: 'status',
  error: 'alert',
}

const ICON_PATH: Record<InlineAlertKind, string> = {
  info: 'M8 7v4.5M8 5v.01',
  success: 'M4.5 8.5l2.2 2.2L11.5 6',
  warning: 'M8 6v3M8 11v.01M8 2l6 11H2z',
  error: 'M8 5v4M8 11v.01',
}

export interface InlineAlertProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  kind: InlineAlertKind
  /** The whole message — a sentence, from the caller's message catalogue. No
   * headline/detail split: that structure is `Banner`'s, this is its compact
   * sibling for inside a form or a card. */
  children: string
  /** The caller renders the alert inside its own live region, mounted before
   * the message appears: the alert then carries no role, so the message is
   * announced once, by that region. A polite region inserted with its content
   * already in it is often not announced at all, so a `status` alert that
   * appears in response to an action needs this. */
  inLiveRegion?: boolean
}

/**
 * No keyboard map: nothing here is a control, and `error` announces itself as
 * `role="alert"` the moment it mounts — which is what makes it right next to
 * the field it is about, not stacked at the top of a long form.
 *
 * `Banner` is the page-level version with a headline, a detail line and an
 * action; this is one line, wherever a form or a card needs to say something
 * about itself.
 */
export const InlineAlert = forwardRef<HTMLDivElement, InlineAlertProps>(function InlineAlert(
  { kind, inLiveRegion = false, className, children, ...rest },
  ref
) {
  return (
    // `{...rest}` first, `role` after — see `Banner.tsx`'s identical comment.
    <div
      ref={ref}
      {...rest}
      role={inLiveRegion ? undefined : ROLE[kind]}
      className={cx(
        'flex items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium',
        KIND[kind],
        className
      )}
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
        className="shrink-0"
      >
        <path d={ICON_PATH[kind]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{children}</span>
    </div>
  )
})

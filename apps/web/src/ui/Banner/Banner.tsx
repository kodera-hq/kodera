import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { CloseIcon } from '../icons/Close'

export type BannerKind = 'info' | 'maintenance' | 'incident' | 'success'

const KIND: Record<BannerKind, string> = {
  info: 'border border-c-border border-l-4 border-l-c-action bg-c-surface text-c-ink',
  maintenance: 'border border-amber-500/40 bg-c-warn-soft text-c-warn-ink',
  // The border is the danger fill at the opacity that lands on the same
  // colour over white — the same token-with-a-modifier `Button.tsx` uses for
  // its destructive variant, kept here rather than a second raw value.
  incident: 'border border-red-500/40 bg-c-bad-soft text-c-bad-ink',
  // `focus-ground-inverse` (`src/index.css`): the action and the dismiss
  // control draw the on-inverse ring on this ground.
  success: 'focus-ground-inverse border border-c-inverse bg-c-inverse text-c-on-inverse',
}

/**
 * `alert` interrupts — a screen reader announces it the moment it appears,
 * over whatever else is being read. That is right for an incident and wrong
 * for everything else here: a `status` region is announced politely, once,
 * without stealing focus from what the person was doing.
 */
const ROLE: Record<BannerKind, 'status' | 'alert'> = {
  info: 'status',
  maintenance: 'status',
  incident: 'alert',
  success: 'status',
}

type DismissProps =
  | {
      /** Requires `dismissLabel` and `onDismiss` together — a dismiss control
       * with no accessible name is not a control this primitive will render. */
      dismissible: true
      dismissLabel: string
      onDismiss: () => void
    }
  | { dismissible?: false; dismissLabel?: undefined; onDismiss?: undefined }

export type BannerProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> &
  DismissProps & {
    kind: BannerKind
    /** What happens — the first of the three lines COMPONENTS.md allows. */
    headline: string
    /** What it changes for the person reading it. */
    detail?: string
    /** The action — a `Button`, from the caller. Never more than one; a
     * banner with a row of choices is a different component. */
    action?: ReactNode
  }

/**
 * Keyboard: `Tab` reaches the action and the dismiss control, in that order —
 * dismissing before acting would be an odd thing to reach first.
 *
 * Three lines, never more (COMPONENTS.md): what happens, what it changes,
 * the action. `InlineAlert` is the compact sibling for inside a form or a
 * card; this is the page-level banner.
 */
export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { kind, headline, detail, action, dismissible, dismissLabel, onDismiss, className, ...rest },
  ref
) {
  return (
    // `{...rest}` first, `role` after: a caller passing its own `role`
    // through the props this primitive forwards must not be able to turn an
    // `incident` banner's assertive interruption into silence.
    <div
      ref={ref}
      {...rest}
      role={ROLE[kind]}
      className={cx('flex items-start gap-3 rounded-md p-4', KIND[kind], className)}
    >
      <div className="flex-1">
        <p className="text-md font-medium">{headline}</p>
        {detail === undefined ? null : <p className="mt-1 text-sm">{detail}</p>}
        {action === undefined ? null : <div className="mt-2">{action}</div>}
      </div>
      {dismissible === true ? (
        // Not `Button`: its tertiary ordinary ink is not on-inverse text,
        // so it cannot supply the readable foreground on the
        // `success` kind. `currentColor` instead — the control always matches
        // the banner's own text colour, on every kind, by construction.
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className={cx(
            // 40 px hit target (COMPONENTS.md, AGENTS.md) — the 32 px control
            // is a `Button`-only exception (`TextField.tsx`), not a general one.
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-sm opacity-70',
            TOUCH_TARGET,
            '-my-2 -mr-2',
            'hover:opacity-100 focus-visible:opacity-100',
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  )
})

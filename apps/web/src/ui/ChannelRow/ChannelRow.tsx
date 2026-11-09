import { Slot, Slottable } from '@radix-ui/react-slot'
import { Fragment, createElement, forwardRef, isValidElement } from 'react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx'
import { EspaceGlyph } from '../icons/EspaceGlyph'
import { hasLabel } from '../stateLabel'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

/**
 * A text channel in Espace's sidebar (`design specification`
 * `design/reference/p02-messages.html`, `.row`): a `#`, the name, and its state.
 * 32 px, 44 px under `narrow:`. A link, since choosing a channel is
 * navigation; `asChild` wraps the router's `Link`, as `RailItem` does.
 *
 * States, each carried by more than colour, and each read in the accessible
 * name in the caller's words (« général, non lu, 3 mentions »):
 * - selected: `aria-current="page"`, the `c-accent-soft` fill and
 *   `c-accent-ink` label, plus a bar at the leading edge and the semibold
 *   weight, so it does not rest on hue;
 * - unread: `c-ink` semibold against the idle `c-ink-2` regular weight;
 * - mentions: a count pill on `c-action` in `c-on-inverse`;
 * - read-only: a lock after the name, in `c-ink-3`.
 * A state is on when its label is given and not empty (`hasLabel`), so it can
 * never show without words; the same predicate decides the look and the name.
 *
 * A direct message is the same row with `leading` in place of the `#`: the
 * other person's 20 px `Avatar`, `aria-hidden` since the name says who it is.
 */
export interface ChannelRowProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  /** The channel's name, without the `#`. */
  name: string
  /** The channel on screen. */
  selected?: boolean
  /** Unread messages wait: the word read after the name, e.g. « non lu ». */
  unread?: string
  /** Messages that mention the viewer: the count drawn, and its words. */
  mentions?: { count: number; label: string }
  /** The viewer reads and cannot post: the word read after the name. */
  readOnly?: string
  /** In place of the `#`: a direct message's 20 px `Avatar`, decorative. */
  leading?: ReactNode
  /** With `asChild` only: the one element the row renders as. Ignored otherwise. */
  children?: ReactNode
  /**
   * Render the caller's element — exactly one, such as the router's `Link` —
   * instead of an `<a>`. Its `aria-current`, `aria-label` and `title` are the
   * row's state and are dropped; the rest of its props are kept.
   */
  asChild?: boolean
}

const BASE =
  'relative flex w-full min-h-8 items-center gap-2 rounded-sm px-2 text-md focus-visible:ring focus-visible:outline-hidden'

const TONE = {
  idle: 'font-regular text-c-ink-3 hover:bg-c-muted hover:text-c-ink',
  unread: 'font-semibold text-c-ink hover:bg-c-muted',
  selected: 'bg-c-accent-soft font-semibold text-c-accent-ink',
} as const

/** A text channel. Rendered inside an `<li>` it creates itself. */
export const ChannelRow = forwardRef<HTMLAnchorElement, ChannelRowProps>(function ChannelRow(
  {
    name,
    selected = false,
    unread,
    mentions,
    readOnly,
    leading,
    asChild = false,
    className,
    children,
    ...rest
  },
  ref
) {
  if (asChild && (!isValidElement(children) || children.type === Fragment)) {
    throw new Error('ChannelRow asChild needs exactly one element child, such as the router’s Link')
  }
  const Comp = asChild ? Slot : 'a'
  const hasMentions = mentions !== undefined && mentions.count > 0 && hasLabel(mentions.label)
  const isUnread = hasLabel(unread)
  const isReadOnly = hasLabel(readOnly)
  const accessibleName = [
    name,
    isUnread ? unread : undefined,
    hasMentions ? mentions.label : undefined,
    isReadOnly ? readOnly : undefined,
  ]
    .filter(hasLabel)
    .join(', ')
  const slotted =
    asChild && isValidElement<Record<string, unknown>>(children)
      ? (() => {
          const {
            'aria-current': _current,
            'aria-label': _label,
            title: _title,
            ...keep
          } = children.props
          return createElement(children.type, { ...keep, key: children.key })
        })()
      : null
  const tone = selected ? TONE.selected : isUnread ? TONE.unread : TONE.idle
  return (
    <li>
      <Comp
        {...rest}
        ref={ref}
        aria-label={accessibleName}
        aria-current={selected ? 'page' : undefined}
        className={cx(BASE, tone, TOUCH_TARGET_HEIGHT, className)}
      >
        {selected ? (
          <span
            aria-hidden="true"
            data-selected-bar=""
            // 3 px, the reference's bar: a one-off length, not a spacing step.
            className="absolute top-1 bottom-1 left-0 w-[3px] rounded-full bg-c-accent-ink"
          />
        ) : null}
        {leading === undefined ? (
          <span
            aria-hidden="true"
            className={cx(
              'w-4 shrink-0 text-center font-medium',
              selected ? 'text-c-accent-ink' : 'text-c-ink-3'
            )}
          >
            #
          </span>
        ) : (
          <span aria-hidden="true" data-leading="" className="flex shrink-0 items-center">
            {leading}
          </span>
        )}
        {asChild ? <Slottable>{slotted}</Slottable> : null}
        <span aria-hidden="true" className="min-w-0 flex-1 truncate">
          {name}
        </span>
        {!isReadOnly ? null : (
          <span aria-hidden="true" className="shrink-0 text-c-ink-3">
            <EspaceGlyph name="lock" className="h-3 w-3" />
          </span>
        )}
        {hasMentions ? (
          <span
            aria-hidden="true"
            className="min-w-5 shrink-0 rounded-full bg-c-action px-1 text-center text-xs leading-body font-bold text-c-on-inverse tabular-nums"
          >
            {mentions.count}
          </span>
        ) : null}
      </Comp>
    </li>
  )
})

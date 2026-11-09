import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from '../cx'
import { CloseIcon } from '../icons/Close'
import type { FocusTarget } from '../returnFocus'
import { TOUCH_TARGET } from '../touchTarget'
import { Tooltip } from '../Tooltip/Tooltip'

/**
 * The thread beside a channel (`design specification`
 * `design/reference/p02-messages.html`, `.aside`): the shell only. A named
 * `complementary` landmark, `shell-dock-width` wide and the full width under
 * `narrow:`, with a header (the title and the parent channel) and a close
 * button, then three slots: the parent message, the replies, the composer.
 *
 * The replies scroll in a named `region` that is itself a tab stop: a scroll
 * box holding nothing focusable can otherwise be read by a mouse and by nobody
 * else (axe's `scrollable-region-focusable`; `region` is the one role
 * `eslint.config.js` allows `tabIndex` on).
 *
 * Closing — the button, or `Escape` anywhere inside the panel — calls
 * `onClose`, then moves focus to `returnFocusTo`, typically the « N réponses »
 * button that opened it. The panel is not a dialog, so Radix's
 * `closeAutoFocusHandler` does not apply; it takes the same `FocusTarget`, read
 * at close time.
 */
export interface ThreadPanelProps {
  /** The landmark's accessible name, e.g. « Fil de discussion ». */
  label: string
  /** The header's title, the panel's heading. */
  title: ReactNode
  /** The parent channel, e.g. « # projet-atlas ». */
  channel: ReactNode
  /** The close button's accessible name. */
  closeLabel: string
  onClose: () => void
  /** Where focus goes once the panel has asked to close. */
  returnFocusTo?: FocusTarget
  /** The message the thread answers, usually a `TimelineMessage`. */
  parent: ReactNode
  /** The replies region's accessible name, e.g. « Réponses ». */
  repliesLabel: string
  /** The replies, usually `TimelineMessage`s. */
  children: ReactNode
  /** The reply composer, pinned under the replies. */
  composer?: ReactNode
}

export function ThreadPanel({
  label,
  title,
  channel,
  closeLabel,
  onClose,
  returnFocusTo,
  parent,
  repliesLabel,
  children,
  composer,
}: ThreadPanelProps) {
  function close() {
    onClose()
    returnFocusTo?.current?.focus()
  }

  // `Escape` from anywhere inside the panel, and only there. A React handler on
  // the landmark, not a native listener: React dispatches from its root, so a
  // native listener here would run before a child's own handler and could not
  // see it call `preventDefault`. With React's bubbling, a child that handles
  // `Escape` itself (a mention picker in the composer) prevents it first and
  // keeps the panel open.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    close()
  }

  return (
    // The landmark is not a control: it only relays `Escape` from the controls
    // inside it, which is what the rule below exists to stop on a static element.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 w-shell-dock-width shrink-0 flex-col border-l border-c-border-soft bg-c-surface narrow:w-full narrow:border-l-0"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-c-border-soft px-4 py-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="min-w-0 truncate text-md font-bold text-c-ink">{title}</h2>
          <span className="min-w-0 truncate text-sm text-c-ink-3">{channel}</span>
        </div>
        <Tooltip content={closeLabel} side="bottom" names>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={close}
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-muted hover:text-c-ink',
              TOUCH_TARGET,
              'focus-visible:ring focus-visible:outline-hidden'
            )}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </header>
      <div className="shrink-0 border-b border-c-border-soft px-4 py-3">{parent}</div>
      <div
        role="region"
        aria-label={repliesLabel}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 py-3 focus-visible:ring focus-visible:outline-hidden focus-visible:ring-inset"
      >
        {children}
      </div>
      {composer === undefined ? null : <div className="shrink-0 px-4 pb-4">{composer}</div>}
    </aside>
  )
}

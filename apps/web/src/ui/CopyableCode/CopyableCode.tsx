import { useId } from 'react'
import { Button } from '../Button/Button'
import { cx } from '../cx'

export type CopyStatus = 'idle' | 'copied'

export interface CopyableCodeProps {
  /** Multi-line values (a set of DNS records) are the point of this
   * primitive over `CopyableField` — whitespace is preserved as written. */
  value: string
  /**
   * What the block holds, e.g. "Enregistrements DNS". Required rather than
   * optional because the block scrolls and is therefore a tab stop of its own
   * (see below): a focus stop with no name is somewhere a screen reader lands
   * and can say nothing about. One string names both the visible label and the
   * region, so the two cannot drift apart.
   */
  label: string
  /** Keeps the label for assistive technology only, for a block already sitting
   * under a heading that says the same thing. The region's name is the same
   * string either way. */
  labelHidden?: boolean
  status: CopyStatus
  copyLabel: string
  copiedLabel: string
  onCopy: () => void
  className?: string
}

/**
 * The block form of COMPONENTS.md's "Copy-value block", for a value too long
 * or too structured for one line — a set of DNS records a person pastes into
 * their registrar. Selectable at all times: the copy button is a shortcut
 * next to the text, never the only way to get the value, so a browser or an
 * OS that blocks clipboard access still leaves the record reachable.
 *
 * Keyboard: `Tab` reaches the block itself and then the copy button,
 * `Enter`/`Space` activates it. Like
 * `CopyableField`, the caller owns `status` and its 1.5 s revert — this
 * primitive holds no timer.
 */
export function CopyableCode({
  value,
  label,
  labelHidden = false,
  status,
  copyLabel,
  copiedLabel,
  onCopy,
  className,
}: CopyableCodeProps) {
  const labelId = useId()

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <p id={labelId} className={cx('text-sm font-medium text-c-ink', labelHidden && 'sr-only')}>
        {label}
      </p>
      <div className="flex items-start justify-between gap-3 rounded-md bg-c-muted p-3">
        {/* A scroll container that can never hold a focusable child: without
            `tabIndex` the far end of a long value is reachable by pointer only
            (WCAG 2.1.1). `role="region"` named by the label above is what that
            new tab stop announces when a screen reader lands on it. */}
        <pre
          role="region"
          aria-labelledby={labelId}
          tabIndex={0}
          className={cx(
            'min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-pre text-c-ink',
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          {value}
        </pre>
        <Button variant="tertiary" size="sm" onClick={onCopy} aria-live="polite">
          {status === 'copied' ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  )
}

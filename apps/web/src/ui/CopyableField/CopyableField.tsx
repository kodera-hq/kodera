import { Button } from '../Button/Button'
import { cx } from '../cx'

export type CopyStatus = 'idle' | 'copied'

export interface CopyableFieldProps {
  label: string
  value: string
  /**
   * Set and reverted by the caller — this primitive holds no timer. The 1.5 s
   * COMPONENTS.md asks for is the caller's `setTimeout`, not something a copy
   * primitive owns; a component-scheduled revert would keep firing after a
   * caller has unmounted it or moved on to a different value.
   */
  status: CopyStatus
  copyLabel: string
  /** Optional field-specific name when the visible copy label is kept short. */
  copyAccessibleLabel?: string
  copiedLabel: string
  onCopy: () => void
  className?: string
  /** Label above its value for paired application address blocks. */
  layout?: 'inline' | 'stacked'
}

/**
 * COMPONENTS.md's "Copy-value block": label · value · copy, on one row. The
 * value is always visible, selectable text — the button is a shortcut, never
 * the only way to get it, which is what "never ask the user to retype"
 * means for a single value.
 *
 * Keyboard: `Tab` reaches the button, `Enter`/`Space` activates it. The
 * button's own label switches between `copyLabel` and `copiedLabel`, and the
 * button carries `aria-live="polite"` so the change is announced even when
 * focus stays elsewhere.
 */
export function CopyableField({
  label,
  value,
  status,
  copyLabel,
  copyAccessibleLabel,
  copiedLabel,
  onCopy,
  className,
  layout = 'inline',
}: CopyableFieldProps) {
  const labelNode = (
    <span className={layout === 'stacked' ? 'text-xs text-c-ink-3' : 'text-sm text-c-ink-2'}>
      {label}
    </span>
  )
  const valueNode = (
    <span className="min-w-0 flex-1 truncate font-mono text-sm text-c-ink">{value}</span>
  )
  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-3 rounded-md px-3 py-3',
        layout === 'stacked' ? 'bg-c-sunken' : 'bg-c-muted',
        className
      )}
    >
      {layout === 'stacked' ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {labelNode}
          {valueNode}
        </div>
      ) : (
        <>
          {labelNode}
          {valueNode}
        </>
      )}
      <Button
        variant="tertiary"
        size="sm"
        onClick={onCopy}
        aria-live="polite"
        aria-label={copyAccessibleLabel}
      >
        {status === 'copied' ? copiedLabel : copyLabel}
      </Button>
    </div>
  )
}

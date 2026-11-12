import type { ReactNode } from 'react'
import { cx } from '../cx'
import { cssProperty } from '../cssom'

type Tier = 'normal' | 'warning' | 'full'

/**
 * COMPONENTS.md: "fill cobalt.500; … ≥ 90 % → fill amber.500 … 100 % → fill
 * red.500." The 90 % marker on the track is drawn regardless of tier — it is
 * where the limit sits, not a statement about where the value is.
 */
const FILL: Record<Tier, string> = {
  normal: 'bg-c-action',
  warning: 'bg-c-warn',
  full: 'bg-c-bad',
}

const STATUS_TEXT: Record<Exclude<Tier, 'normal'>, string> = {
  warning: 'text-c-warn-ink',
  full: 'text-c-bad-ink',
}

function tierOf(ratio: number): Tier {
  if (ratio >= 1) return 'full'
  if (ratio >= 0.9) return 'warning'
  return 'normal'
}

export interface GaugeProps {
  label: string
  /** 0–100 (or 0–`max`). Drives the fill width and `aria-valuenow`; never
   * rendered as text directly — `valueText` is what a person and a screen
   * reader both read. */
  value: number
  max?: number
  /** Preformatted by the caller, mono, e.g. "62 / 100" — the same rule
   * `PriceLine` follows, this primitive does not format a number. */
  valueText: string
  /** Word half of "word + colour", shown once the gauge reaches the 90%
   * threshold. Omitting it at that threshold is a caller mistake this
   * primitive cannot catch — the colour alone is never enough. */
  statusLabel?: string
  /** Shown only at 100%, next to `statusLabel` — COMPONENTS.md: "label
   * amber.600 … 100 % → … red.600 with the timestamp of the last refusal." */
  timestamp?: string
  /** An upgrade CTA, shown from the 90% threshold up. */
  action?: ReactNode
}

/**
 * `role="meter"`: a capacity gauge reports a measured quantity against a
 * range, which is exactly what `meter` means (a `progressbar` is for a task
 * running to completion, not a resource level). The fill's width is the only
 * computed `style` here — the 90% threshold marker is a fixed design
 * constant and is drawn with a class, and the colour and every other value
 * on the track still comes from a token class.
 */
export function Gauge({
  label,
  value,
  max = 100,
  valueText,
  statusLabel,
  timestamp,
  action,
}: GaugeProps) {
  const ratio = max === 0 ? 0 : value / max
  const tier = tierOf(ratio)
  const percent = Math.min(100, Math.max(0, ratio * 100))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-c-ink">{label}</span>
        <span className="font-mono text-sm text-c-ink">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={valueText}
        // No 6px step exists in the tokens package (spacing is
        // 4/8/12/16/20/24/32/40/48), so the track height is a bracket value
        // — the same move `Stepper`'s upcoming ring makes for its own
        // missing border step.
        className="relative h-[6px] w-full overflow-hidden rounded-full bg-c-muted-2"
      >
        <div
          data-gauge-fill=""
          ref={cssProperty('width', `${percent}%`)}
          className={cx('h-full rounded-full', FILL[tier])}
        />
        <div aria-hidden="true" className="absolute inset-y-0 left-[90%] w-px bg-c-inverse" />
      </div>
      {tier === 'normal' || statusLabel === undefined ? null : (
        <p className={cx('text-xs font-medium', STATUS_TEXT[tier])}>
          {statusLabel}
          {tier === 'full' && timestamp !== undefined ? (
            <span className="ml-2 font-regular text-c-ink-3">{timestamp}</span>
          ) : null}
        </p>
      )}
      {tier === 'normal' || action === undefined ? null : <div>{action}</div>}
    </div>
  )
}

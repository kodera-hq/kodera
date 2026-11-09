import qrcode from 'qrcode-generator'
import { forwardRef, useMemo } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { CopyableField } from '../CopyableField/CopyableField'
import type { CopyableFieldProps } from '../CopyableField/CopyableField'
import { cx } from '../cx'

export type QrPanelSize = 'sm' | 'md' | 'lg'

/**
 * A QR's practical minimum is well past the tokens package's spacing scale
 * (4–48 px) — the same gap `Dialog`'s `md`/`lg` widths and `EmptyState`'s body
 * measure fill with a bracket value rather than a step the grid does not
 * have. `PX` drives the SVG's own `width`/`height` attributes (plain numbers,
 * not a Tailwind class, the same move every icon in this inventory makes);
 * `BOX_CLASS` sizes the failure placeholder to match, in bracket px so the
 * spacing guard can still judge it. The two must be kept in sync by hand.
 */
const PX: Record<QrPanelSize, number> = { sm: 96, md: 144, lg: 192 }
const BOX_CLASS: Record<QrPanelSize, string> = {
  sm: 'h-[96px] w-[96px]',
  md: 'h-[144px] w-[144px]',
  lg: 'h-[192px] w-[192px]',
}

// The QR standard's own quiet zone: four empty modules on every side, so a
// camera's own detector has margin to lock onto the finder patterns. Not a
// spacing token — it is counted in QR modules, not pixels, and scales with
// whatever module size the SVG's `viewBox` ends up drawing at.
const QUIET_ZONE_MODULES = 4

interface QrEncoding {
  moduleCount: number
  path: string
}

/**
 * One SVG path, all the dark modules at once, rather than one `<rect>` per
 * module — the same shape a scannable QR needs either way, at a fraction of
 * the DOM nodes. `L`, not the `h`/`v`/`w` shorthand a path could also use:
 * those letters collide with this codebase's own spacing-utility prefixes on
 * sight, and a reviewer should not have to check whether a "w" in a path
 * string is markup.
 */
function encode(value: string): QrEncoding | null {
  const trimmed = value.trim()
  if (trimmed === '') return null

  try {
    const qr = qrcode(0, 'M')
    qr.addData(trimmed)
    qr.make()

    const moduleCount = qr.getModuleCount()
    let path = ''
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (!qr.isDark(row, col)) continue
        const x = col + QUIET_ZONE_MODULES
        const y = row + QUIET_ZONE_MODULES
        path += `M${x} ${y}L${x + 1} ${y}L${x + 1} ${y + 1}L${x} ${y + 1}Z`
      }
    }

    return { moduleCount, path }
  } catch {
    // `qrcode-generator` throws when `value` overflows the largest QR version
    // it can build ("code length overflow"). A caller passing a value this
    // long is a caller mistake this primitive cannot fix — it renders the
    // same failure state as an empty value, never a broken image.
    return null
  }
}

export interface QrPanelProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  /**
   * The data encoded in the QR — an `otpauth://` URI, a join URL. Encoded
   * client-side, with no network request of any kind.
   */
  value: string
  /** The QR's text alternative, wired as the SVG's accessible name. From the
   * caller's message catalogue — a primitive holds no string a customer
   * reads. */
  alt: string
  size?: QrPanelSize
  /**
   * The copyable short code beside the QR — COMPONENTS.md's pairing, a
   * human-typable fallback for a camera that cannot be used. This primitive
   * renders it with `CopyableField` untouched; the caller supplies that
   * primitive's own props (and usually a different, formatted string than
   * `value` — the mockups show a grouped secret next to a URL-shaped QR).
   */
  code: Omit<CopyableFieldProps, 'className'>
  /**
   * Shown instead of the QR when `value` is empty or the encoder cannot build
   * one — the short code stays, and this is text, never a broken `<img>`.
   */
  failureMessage: string
}

/**
 * No keyboard map of its own beyond `CopyableField`'s copy button — the QR
 * image is not a control. `role="img"` names it with `alt` rather than
 * leaving an inline SVG for a screen reader to describe module by module.
 */
export const QrPanel = forwardRef<HTMLDivElement, QrPanelProps>(function QrPanel(
  { value, alt, size = 'md', code, failureMessage, className, ...rest },
  ref
) {
  const encoded = useMemo(() => encode(value), [value])
  const dimension = encoded === null ? 0 : encoded.moduleCount + QUIET_ZONE_MODULES * 2

  return (
    <div ref={ref} {...rest} className={cx('flex items-start gap-4', className)}>
      {encoded === null ? (
        <div
          className={cx(
            'flex shrink-0 items-center justify-center rounded-md border border-dashed border-c-border-strong',
            'bg-c-muted p-2 text-center text-xs text-c-ink-2',
            BOX_CLASS[size]
          )}
        >
          {failureMessage}
        </div>
      ) : (
        <svg
          role="img"
          aria-label={alt}
          viewBox={`0 0 ${dimension} ${dimension}`}
          width={PX[size]}
          height={PX[size]}
          className="shrink-0"
        >
          <rect width={dimension} height={dimension} className="fill-c-surface" />
          <path d={encoded.path} className="fill-c-ink" />
        </svg>
      )}
      <CopyableField {...code} className="flex-1" />
    </div>
  )
})

import { cx } from '../cx'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

export interface BreadcrumbItem {
  label: string
  /** Omitted on the last item: the current page is text, not a link to
   * itself. */
  href?: string
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[]
  /** Accessible name for the `nav` landmark, e.g. "Fil d'Ariane". */
  ariaLabel: string
}

/** Decorative, and therefore inside the `li` it belongs to rather than
 * between two of them: an `ol` may hold only `li` (plus `script`/`template`),
 * and `aria-hidden` on a stray `span` hides that from axe's `list` rule
 * instead of fixing it. `Stepper` keeps its own connector inside the `li` for
 * the same reason. */
function Separator() {
  return (
    <span aria-hidden="true" className="text-c-ink-3">
      /
    </span>
  )
}

/**
 * `nav > ol`, one `li` per level, each carrying its own leading separator.
 * The last item carries `aria-current="page"`
 * and is plain text — a link to the page already open teaches nothing and
 * gives a keyboard user a stop with nothing behind it.
 *
 * Keyboard: `Tab` reaches every link in order; the current item is not
 * focusable, the same way a disabled control is not.
 */
export function Breadcrumb({ items, ariaLabel }: BreadcrumbProps) {
  return (
    <nav aria-label={ariaLabel}>
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <li key={item.label} className="flex items-center gap-2">
              {index === 0 ? null : <Separator />}
              {isLast || item.href === undefined ? (
                <span aria-current={isLast ? 'page' : undefined} className="text-c-ink">
                  {item.label}
                </span>
              ) : (
                <a
                  href={item.href}
                  className={cx(
                    'text-c-ink-3 underline-offset-2 hover:text-c-accent-ink hover:underline',
                    // A standalone link in a phone's trail, not a word in a
                    // sentence: it gets the touch-target floor.
                    'narrow:inline-flex narrow:items-center',
                    TOUCH_TARGET_HEIGHT,
                    'focus-visible:ring focus-visible:outline-hidden'
                  )}
                >
                  {item.label}
                </a>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

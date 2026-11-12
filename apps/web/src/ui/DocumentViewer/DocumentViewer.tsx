import { forwardRef, useId, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode, UIEvent } from 'react'
import { Card, CardBody, CardHeader } from '../Card/Card'
import { cx } from '../cx'
import { InlineAlert } from '../InlineAlert/InlineAlert'
import { LINK_TEXT } from '../linkText'
import { Skeleton } from '../Skeleton/Skeleton'
import { cssProperty } from '../cssom'

export interface DocumentViewerSection {
  id: string
  heading: string
  paragraphs: string[]
}

type DocumentViewerStateProps =
  | { status: 'loading'; sections?: undefined; failureMessage?: undefined }
  | { status: 'failed'; failureMessage: string; sections?: undefined }
  | { status: 'ready'; sections: DocumentViewerSection[]; failureMessage?: undefined }

export type DocumentViewerProps = Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'title'> &
  DocumentViewerStateProps & {
    /** The panel's visible title and the scrollable region's accessible
     * name — "Contrat de sous-traitance — ACME Construction" in the
     * mockup. */
    label: string
    /** Accessible name for the in-panel table of contents. */
    tocLabel: string
    /** Accessible name for the read-progress indicator, e.g. "Progression
     * de lecture". */
    progressLabel: string
    printAction?: ReactNode
    downloadAction?: ReactNode
    /** Fires once, the first time the region reaches the end — not on every
     * scroll event after that. A document short enough to need no
     * scrolling at all counts as read on mount, the same way a page nobody
     * has to turn is not unread. */
    onReadToEnd?: () => void
  }

// One JS-driven step per keypress rather than leaning on a browser's own
// "focused scrollable region" behaviour: that behaviour is real in Chrome but
// not guaranteed everywhere, and a jsdom test has no scrolling of its own to
// assert on either way. Routing every scroll — key-driven or not — through
// one `scrollTop` write and one dispatched `scroll` event keeps the
// read-progress calculation in a single place.
const LINE_STEP = 40

function readyProgress(el: HTMLElement): number {
  const scrollable = el.scrollHeight - el.clientHeight
  if (scrollable <= 0) return 100
  return Math.min(100, Math.round(((el.scrollTop + el.clientHeight) / el.scrollHeight) * 100))
}

/**
 * `role="region"`, `tabIndex={0}`, labelled by `label` — the WAI-ARIA
 * pattern for a scrollable region a keyboard user can reach and scroll on
 * its own, independent of any control inside it. Internal headings continue
 * the page outline at `h3` (`01-order.md` §10). The heading outline doubles
 * as a table of contents: activating an entry scrolls that heading into view
 * and moves focus to it, the same "land on the heading, not just the pixel"
 * behaviour `01-order.md` asks for when a table row opens a document.
 */
export const DocumentViewer = forwardRef<HTMLDivElement, DocumentViewerProps>(
  function DocumentViewer(
    {
      label,
      tocLabel,
      progressLabel,
      printAction,
      downloadAction,
      onReadToEnd,
      status,
      sections,
      failureMessage,
      className,
      ...rest
    },
    ref
  ) {
    const titleId = useId()
    const scrollRef = useRef<HTMLDivElement>(null)
    const headingRefs = useRef(new Map<string, HTMLHeadingElement>())
    const [progress, setProgress] = useState(0)
    const readToEndFired = useRef(false)

    const fireReadToEnd = () => {
      if (readToEndFired.current) return
      readToEndFired.current = true
      onReadToEnd?.()
    }

    const updateProgress = () => {
      const el = scrollRef.current
      if (el === null) return
      const percent = readyProgress(el)
      setProgress(percent)
      if (percent >= 100) fireReadToEnd()
    }

    // A ref callback, not `useEffect`: it runs the moment `status` becomes
    // `ready` and the scrollable node first mounts, which is exactly when a
    // short document — one that needs no scrolling at all — has to be
    // counted as already read.
    const attachScrollRef = (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (node !== null) updateProgress()
    }

    function handleScroll(_event: UIEvent<HTMLDivElement>) {
      updateProgress()
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const el = scrollRef.current
      if (el === null) return

      let next: number | undefined
      switch (event.key) {
        case 'ArrowDown':
          next = el.scrollTop + LINE_STEP
          break
        case 'ArrowUp':
          next = el.scrollTop - LINE_STEP
          break
        case ' ':
        case 'PageDown':
          next = el.scrollTop + el.clientHeight
          break
        case 'PageUp':
          next = el.scrollTop - el.clientHeight
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = el.scrollHeight
          break
        default:
          return
      }

      event.preventDefault()
      el.scrollTop = next
      // jsdom never fires `scroll` from a plain property write — only a real
      // layout engine does that. Dispatching it by hand keeps keyboard
      // scrolling and pointer/wheel scrolling on the exact same code path
      // (`handleScroll` above) in both the browser and the test suite.
      el.dispatchEvent(new Event('scroll'))
    }

    function goToSection(id: string) {
      const heading = headingRefs.current.get(id)
      heading?.scrollIntoView()
      heading?.focus()
    }

    const progressPercent = status === 'ready' ? progress : 0

    return (
      <Card ref={ref} {...rest} className={cx('flex flex-col', className)}>
        <CardHeader>
          <h2 id={titleId} className="text-lg font-semibold text-c-ink">
            {label}
          </h2>
          {printAction === undefined && downloadAction === undefined ? null : (
            <div className="flex items-center gap-2">
              {printAction}
              {downloadAction}
            </div>
          )}
        </CardHeader>

        {status === 'loading' ? (
          <CardBody className="flex flex-col gap-2">
            <Skeleton />
            <Skeleton />
            <Skeleton shape="text" />
            <Skeleton shape="text" />
          </CardBody>
        ) : null}

        {status === 'failed' ? (
          <CardBody>
            <InlineAlert kind="error">{failureMessage}</InlineAlert>
          </CardBody>
        ) : null}

        {status === 'ready' ? (
          <CardBody className="flex flex-col gap-4">
            <nav aria-label={tocLabel}>
              <ol className="flex flex-col gap-1">
                {sections.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => goToSection(section.id)}
                      className={cx(
                        'rounded-sm text-left text-sm outline-hidden focus-visible:ring',
                        LINK_TEXT.standalone
                      )}
                    >
                      {section.heading}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>

            {/* No token for a 240 px reading pane — a bracket value, the same
             * move `Dialog`'s sizes and `EmptyState`'s body measure make for
             * a value the grid has no step for.
             *
             * `jsx-a11y`'s interactive-role allowlist for `tabIndex` and for
             * `onScroll`/`onKeyDown` does not include `role="region"` — but
             * the WAI-ARIA Authoring Practices ask for exactly this shape
             * for a scrollable region: focusable on its own, independent of
             * any control inside it, so a keyboard user can reach and
             * scroll it without one. */}
            {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */}
            <div
              ref={attachScrollRef}
              role="region"
              tabIndex={0}
              aria-labelledby={titleId}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              className="max-h-[240px] overflow-y-auto rounded-sm border border-c-border-soft p-4 focus-visible:ring focus-visible:outline-hidden"
            >
              {sections.map((section) => (
                <section key={section.id} className="mb-4 last:mb-0">
                  <h3
                    ref={(node) => {
                      if (node === null) headingRefs.current.delete(section.id)
                      else headingRefs.current.set(section.id, node)
                    }}
                    tabIndex={-1}
                    className="mb-2 text-sm font-semibold text-c-ink"
                  >
                    {section.heading}
                  </h3>
                  {section.paragraphs.map((paragraph, index) => (
                    <p key={index} className="mb-2 text-sm text-c-ink-2 last:mb-0">
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions */}

            <div
              role="progressbar"
              aria-label={progressLabel}
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1 w-full overflow-hidden rounded-full bg-c-muted-2"
            >
              <div
                ref={cssProperty('width', `${progressPercent}%`)}
                className="h-full rounded-full bg-c-action"
              />
            </div>
          </CardBody>
        ) : null}
      </Card>
    )
  }
)

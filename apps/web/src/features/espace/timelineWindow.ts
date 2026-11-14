// Which rows of a channel's log are drawn (docs/specs/espace-timeline-scale.md). A room can hold
// ten thousand messages; the browser lays out only the few on screen and a margin around them, and
// two spacers stand in for the rest at their measured or estimated heights, so the scrollbar and
// the member's place stay true. A pure function of the rows' sizes and the log's scroll: every rule
// is a unit test away, and the hook that measures (`timelineVirtualizer.ts`) holds no layout logic.

/** No log draws more rows than this, whatever the screen: the DOM stays small at any history. */
export const MAX_DRAWN_ROWS = 60

/** Rows drawn beyond each edge of the screen, so a short scroll never shows a blank. */
export const OVERSCAN_ROWS = 8

export interface WindowInput {
  /** How many rows the log holds. */
  count: number
  /** The top of each row and the end of the last: `offsets[i]` is row i's top, `offsets[count]` the total. */
  offsets: Float64Array
  /** How far the list is scrolled, measured from the list's own top. */
  scrollTop: number
  /** The height of the log on screen. */
  viewport: number
  /** The member reads the newest messages: the window ends on the last row whatever `scrollTop` says. */
  followEnd: boolean
  overscan?: number
  maxRows?: number
}

export interface TimelineWindow {
  /** The first row drawn. */
  start: number
  /** One past the last row drawn. */
  end: number
  /** The spacer above the drawn rows, in pixels. */
  before: number
  /** The spacer below them. */
  after: number
}

/** Each row's top, from its size: `sizeOf(i)` is the measured height, or the estimate before one. */
export function rowOffsets(count: number, sizeOf: (index: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1)
  for (let index = 0; index < count; index += 1)
    offsets[index + 1] = offsets[index]! + sizeOf(index)
  return offsets
}

/** The last row whose top is at or above `y`: the row `y` falls in. */
export function rowAt(offsets: Float64Array, count: number, y: number): number {
  if (count === 0) return 0
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle]! <= y) low = middle
    else high = middle - 1
  }
  return low
}

export function timelineWindow({
  count,
  offsets,
  scrollTop,
  viewport,
  followEnd,
  overscan = OVERSCAN_ROWS,
  maxRows = MAX_DRAWN_ROWS,
}: WindowInput): TimelineWindow {
  if (count === 0) return { start: 0, end: 0, before: 0, after: 0 }
  const total = offsets[count]!
  const top = followEnd ? Math.max(0, total - viewport) : Math.min(Math.max(0, scrollTop), total)
  const first = rowAt(offsets, count, top)
  const last = Math.min(count - 1, rowAt(offsets, count, top + Math.max(0, viewport) - 0.5))
  let start = Math.max(0, first - overscan)
  let end = Math.min(count, last + 1 + overscan)
  if (end - start > maxRows) {
    // The margin goes first, evenly; then, on a screen taller than the cap, the rows below.
    const visible = last + 1 - first
    if (visible >= maxRows) {
      start = followEnd ? last + 1 - maxRows : first
      end = start + maxRows
    } else {
      const margin = maxRows - visible
      const above = Math.min(first, Math.floor(margin / 2))
      end = Math.min(count, last + 1 + (margin - above))
      start = Math.max(0, end - maxRows)
    }
  }
  return { start, end, before: offsets[start]!, after: total - offsets[end]! }
}

export function sameWindow(a: TimelineWindow, b: TimelineWindow): boolean {
  return a.start === b.start && a.end === b.end
}

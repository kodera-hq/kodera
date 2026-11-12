// The measuring half of the virtual log (`timelineWindow.ts` is the arithmetic). It keeps each
// drawn row's height once the browser has laid it out, re-reads the window when the member scrolls
// or the log changes size, and sizes the two spacers that stand in for the rows not drawn.
//
// Sizes go through the CSSOM, never a `style` attribute (the console's policy refuses those). A row
// above the screen that turns out taller or shorter than its estimate moves the log by the
// difference, so what the member reads stays where it is; a log at its newest message stays there.
//
// The window is re-read in the scroll event itself and drawn synchronously: the browser dispatches
// scroll before it paints, so a programmatic scroll (opening on the newest message, keeping the
// place above older ones) never shows a blank frame.
//
// The state lives in a small store the log subscribes to (`useSyncExternalStore`): the layout it
// reads belongs to the browser, not to React, and a store is how React reads outside state.

import { createRef, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
import { EDGE_PX } from './useTimelineScroll'
import {
  rowAt,
  rowOffsets,
  sameWindow,
  timelineWindow,
  type TimelineWindow,
} from './timelineWindow'

/** The attribute each drawn row carries: its key, so a measurement finds its row again. */
export const ROW_KEY_ATTRIBUTE = 'data-timeline-row'

/** The height the first draw assumes before the log is laid out. */
const FIRST_DRAW_VIEWPORT = 1200

export interface VirtualizerOptions {
  /** Every row's key, in order. A new array is a change to draw. */
  keys: readonly string[]
  /** A row's height before it is drawn. */
  estimate: (index: number) => number
  /** The scrolling log. */
  scrollRef: RefObject<HTMLDivElement | null>
}

export interface Virtualizer {
  window: TimelineWindow
  /** Put on the list that holds the drawn rows and the two spacers. */
  listRef: RefObject<HTMLDivElement | null>
  beforeRef: RefObject<HTMLDivElement | null>
  afterRef: RefObject<HTMLDivElement | null>
  /** Brings a row into the middle of the log, drawing it first; false when no row has that key. */
  scrollToKey: (key: string) => boolean
}

function setHeight(element: HTMLElement | null, height: number) {
  element?.style.setProperty('height', `${Math.max(0, Math.round(height))}px`)
}

/** A drawn row's index: near the window's start first, then anywhere. */
function indexOf(keys: readonly string[], key: string, near: number): number {
  for (let index = near; index < Math.min(keys.length, near + 128); index += 1) {
    if (keys[index] === key) return index
  }
  return keys.indexOf(key)
}

/** One log's layout: the rows' measured heights, the window drawn, and the member's place. */
export class TimelineLayout {
  readonly listRef = createRef<HTMLDivElement>()
  readonly beforeRef = createRef<HTMLDivElement>()
  readonly afterRef = createRef<HTMLDivElement>()
  private log: HTMLDivElement | null = null
  private keys: readonly string[]
  private estimate: (index: number) => number
  private readonly heights = new Map<string, number>()
  /** The rows' tops, kept until the rows or a measured height change: one pass per change. */
  private tops: Float64Array | null = null
  /** The log ends on its newest row: true until the member scrolls up. */
  private followEnd = true
  private shown: TimelineWindow
  private readonly listeners = new Set<() => void>()

  constructor(keys: readonly string[], estimate: (index: number) => number) {
    this.keys = keys
    this.estimate = estimate
    this.shown = this.windowAt(0, 0)
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): TimelineWindow => this.shown

  /** The rows drawn now; a new keys array drops the tops, a measured height keeps its row's. */
  setRows(keys: readonly string[], estimate: (index: number) => number) {
    if (keys !== this.keys) this.tops = null
    this.keys = keys
    this.estimate = estimate
  }

  /** Follows a log element: its scroll moves the window, its size and the list's re-measure. */
  attach(log: HTMLDivElement | null): () => void {
    this.log = log
    if (log === null) return () => {}
    const onScroll = () => {
      this.followEnd = log.scrollHeight - log.scrollTop - log.clientHeight < EDGE_PX
      this.redraw(true)
    }
    log.addEventListener('scroll', onScroll, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.measure()
            this.redraw(true)
          })
    observer?.observe(log)
    if (this.listRef.current !== null) observer?.observe(this.listRef.current)
    return () => {
      log.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (this.log === log) this.log = null
    }
  }

  private offsets(): Float64Array {
    if (this.tops === null) {
      const { keys, estimate, heights } = this
      this.tops = rowOffsets(keys.length, (index) => heights.get(keys[index]!) ?? estimate(index))
    }
    return this.tops
  }

  private windowAt(scrollTop: number, viewport: number): TimelineWindow {
    // Before the log has a height (the first draw), draw as if it were a tall screen.
    return timelineWindow({
      count: this.keys.length,
      offsets: this.offsets(),
      scrollTop,
      viewport: viewport > 0 ? viewport : FIRST_DRAW_VIEWPORT,
      followEnd: this.followEnd,
    })
  }

  /** The window for the log's scroll now, its rows sized as measured. */
  private read(): TimelineWindow {
    const log = this.log
    const list = this.listRef.current
    if (log === null || list === null) return this.windowAt(0, 0)
    return this.windowAt(log.scrollTop - list.offsetTop, log.clientHeight)
  }

  /** Draws the window again if it moved; synchronously from a scroll, so no frame is blank. */
  redraw(synchronously: boolean) {
    const next = this.read()
    if (sameWindow(next, this.shown)) return
    this.shown = next
    const notify = () => {
      for (const listener of this.listeners) listener()
    }
    if (synchronously) flushSync(notify)
    else notify()
  }

  /**
   * Reads the drawn rows' heights, sizes the spacers, and keeps the member's place: a row above the
   * screen that changed size moves the log by as much, and a log following its end stays there.
   */
  measure() {
    const log = this.log
    const list = this.listRef.current
    if (log === null || list === null) return
    const { keys, estimate, heights } = this
    const { start } = this.shown
    const scrollTop = log.scrollTop - list.offsetTop
    const firstOnScreen = rowAt(this.offsets(), keys.length, Math.max(0, scrollTop))
    let shift = 0
    for (const element of list.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`)) {
      const key = element.getAttribute(ROW_KEY_ATTRIBUTE)
      if (key === null) continue
      const height = element.getBoundingClientRect().height
      // Nothing laid out (a hidden log, a test's document): keep what is known.
      if (height === 0) continue
      const index = indexOf(keys, key, start)
      if (index === -1) continue
      const known = heights.get(key) ?? estimate(index)
      if (Math.abs(known - height) < 0.5) continue
      heights.set(key, height)
      this.tops = null
      if (index < firstOnScreen) shift += height - known
    }
    const tops = this.offsets()
    const { start: from, end: to } = this.shown
    setHeight(this.beforeRef.current, tops[from] ?? 0)
    setHeight(this.afterRef.current, (tops[keys.length] ?? 0) - (tops[to] ?? 0))
    if (this.followEnd) log.scrollTop = log.scrollHeight
    else if (shift !== 0) log.scrollTop += shift
  }

  readonly scrollToKey = (key: string): boolean => {
    const index = this.keys.indexOf(key)
    const log = this.log
    const list = this.listRef.current
    if (index === -1 || log === null || list === null) return false
    this.followEnd = false
    const tops = this.offsets()
    const middle = tops[index]! + (tops[index + 1]! - tops[index]!) / 2
    log.scrollTop = Math.max(0, list.offsetTop + middle - log.clientHeight / 2)
    this.redraw(true)
    // Drawn now, and measured: centre it again on its real height, moving this log only.
    const element = this.rowElement(key)
    if (element !== undefined) {
      const row = element.getBoundingClientRect()
      const frame = log.getBoundingClientRect()
      log.scrollTop += row.top + row.height / 2 - (frame.top + log.clientHeight / 2)
    }
    return true
  }

  /** The drawn element of a row, if it is drawn. */
  rowElement(key: string): HTMLElement | undefined {
    const list = this.listRef.current
    if (list === null) return undefined
    return [...list.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`)].find(
      (row) => row.getAttribute(ROW_KEY_ATTRIBUTE) === key
    )
  }
}

export function useTimelineVirtualizer({
  keys,
  estimate,
  scrollRef,
}: VirtualizerOptions): Virtualizer & { layout: TimelineLayout } {
  const [layout] = useState(() => new TimelineLayout(keys, estimate))
  const window = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot)

  // Every draw: take the rows drawn, measure them, then draw again if the window moved.
  useLayoutEffect(() => {
    layout.setRows(keys, estimate)
    layout.measure()
    layout.redraw(false)
  })

  useLayoutEffect(() => layout.attach(scrollRef.current), [layout, scrollRef])

  return {
    window,
    listRef: layout.listRef,
    beforeRef: layout.beforeRef,
    afterRef: layout.afterRef,
    scrollToKey: layout.scrollToKey,
    layout,
  }
}

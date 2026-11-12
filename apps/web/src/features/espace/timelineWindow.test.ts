import { describe, expect, it } from 'vitest'
import {
  MAX_DRAWN_ROWS,
  OVERSCAN_ROWS,
  rowAt,
  rowOffsets,
  timelineWindow,
  type TimelineWindow,
} from './timelineWindow'

const TEN_THOUSAND = 10_000

function uniform(count: number, size: number) {
  return rowOffsets(count, () => size)
}

/** The spacers and the drawn rows add up to the whole log: the scrollbar tells the truth. */
function expectWhole(window: TimelineWindow, offsets: Float64Array, count: number) {
  const drawn = offsets[window.end]! - offsets[window.start]!
  expect(window.before + drawn + window.after).toBe(offsets[count])
}

describe('rowOffsets and rowAt', () => {
  it('places each row under the one before it', () => {
    const offsets = rowOffsets(3, (index) => [10, 20, 30][index]!)
    expect([...offsets]).toEqual([0, 10, 30, 60])
  })

  it('finds the row a point falls in, edges included', () => {
    const offsets = rowOffsets(3, (index) => [10, 20, 30][index]!)
    expect(rowAt(offsets, 3, 0)).toBe(0)
    expect(rowAt(offsets, 3, 9.9)).toBe(0)
    expect(rowAt(offsets, 3, 10)).toBe(1)
    expect(rowAt(offsets, 3, 59)).toBe(2)
    expect(rowAt(offsets, 3, 600)).toBe(2)
    expect(rowAt(offsets, 0, 0)).toBe(0)
  })
})

describe('timelineWindow', () => {
  it('draws nothing for an empty log', () => {
    expect(
      timelineWindow({
        count: 0,
        offsets: new Float64Array(1),
        scrollTop: 0,
        viewport: 800,
        followEnd: true,
      })
    ).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })

  it('draws every row of a short log', () => {
    const offsets = uniform(5, 50)
    const window = timelineWindow({
      count: 5,
      offsets,
      scrollTop: 0,
      viewport: 800,
      followEnd: true,
    })
    expect(window).toEqual({ start: 0, end: 5, before: 0, after: 0 })
  })

  it('opens ten thousand messages on the newest, drawing at most sixty rows', () => {
    const offsets = uniform(TEN_THOUSAND, 56)
    const window = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 0,
      viewport: 900,
      followEnd: true,
    })
    expect(window.end).toBe(TEN_THOUSAND)
    expect(window.end - window.start).toBeLessThanOrEqual(MAX_DRAWN_ROWS)
    // The screen is covered: 900 px of 56 px rows, and the margin above it.
    expect(window.end - window.start).toBeGreaterThanOrEqual(Math.ceil(900 / 56) + OVERSCAN_ROWS)
    expect(window.after).toBe(0)
    expectWhole(window, offsets, TEN_THOUSAND)
  })

  it('draws the rows under the scroll and a margin on each side', () => {
    const offsets = uniform(TEN_THOUSAND, 50)
    const window = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 5000 * 50,
      viewport: 500,
      followEnd: false,
    })
    expect(window.start).toBe(5000 - OVERSCAN_ROWS)
    expect(window.end).toBe(5010 + OVERSCAN_ROWS)
    expectWhole(window, offsets, TEN_THOUSAND)
  })

  it('reaches the first message at the top of the log', () => {
    const offsets = uniform(TEN_THOUSAND, 50)
    const window = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 0,
      viewport: 500,
      followEnd: false,
    })
    expect(window.start).toBe(0)
    expect(window.before).toBe(0)
  })

  it('holds the cap on a screen taller than sixty rows, keeping what is on screen', () => {
    const offsets = uniform(TEN_THOUSAND, 10)
    const top = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 1000 * 10,
      viewport: 2000,
      followEnd: false,
    })
    expect(top.end - top.start).toBe(MAX_DRAWN_ROWS)
    expect(top.start).toBe(1000)
    const bottom = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 0,
      viewport: 2000,
      followEnd: true,
    })
    expect(bottom.end).toBe(TEN_THOUSAND)
    expect(bottom.end - bottom.start).toBe(MAX_DRAWN_ROWS)
  })

  it('spends the margin evenly when the cap leaves only part of it', () => {
    const offsets = uniform(TEN_THOUSAND, 20)
    const window = timelineWindow({
      count: TEN_THOUSAND,
      offsets,
      scrollTop: 4000 * 20,
      viewport: 1000,
      followEnd: false,
    })
    expect(window.end - window.start).toBe(MAX_DRAWN_ROWS)
    expect(window.start).toBe(4000 - 5)
    expect(window.end).toBe(4050 + 5)
  })

  it('measures a row it has never drawn at its estimate, and a measured one at its size', () => {
    const sizes = new Map([[2, 300]])
    const offsets = rowOffsets(6, (index) => sizes.get(index) ?? 40)
    const window = timelineWindow({
      count: 6,
      offsets,
      scrollTop: 0,
      viewport: 50,
      followEnd: false,
    })
    expect(offsets[3]).toBe(380)
    expectWhole(window, offsets, 6)
  })

  it('lays out ten thousand rows well within one frame', () => {
    const sizes = Array.from({ length: TEN_THOUSAND }, (_, index) => 40 + (index % 7) * 9)
    const runs: number[] = []
    for (let run = 0; run < 25; run += 1) {
      const started = performance.now()
      const offsets = rowOffsets(TEN_THOUSAND, (index) => sizes[index]!)
      timelineWindow({
        count: TEN_THOUSAND,
        offsets,
        scrollTop: run * 1000,
        viewport: 900,
        followEnd: run % 2 === 0,
      })
      runs.push(performance.now() - started)
    }
    runs.sort((a, b) => a - b)
    // The median of the runs, a frame being 16 ms: the rest of the frame is React's and the browser's.
    expect(runs[Math.floor(runs.length / 2)]).toBeLessThan(4)
  })
})

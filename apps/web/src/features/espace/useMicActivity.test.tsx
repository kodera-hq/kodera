import { act, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  meterFill,
  meterTransform,
  SPEAKING_HOLD_MS,
  SPEAKING_LEVEL,
  useMicActivity,
} from './useMicActivity'

function Probe({
  level,
  active,
  ringable = true,
  panel = false,
}: {
  level: (() => number) | undefined
  active: boolean
  ringable?: boolean
  panel?: boolean
}) {
  const { meterRef, panelMeterRef, speakingRef } = useMicActivity(level, active)
  return (
    <div>
      <span data-testid="fill" ref={meterRef} />
      <span data-testid="face" ref={ringable ? speakingRef : undefined} />
      {panel ? <span data-testid="panel-fill" ref={panelMeterRef} /> : null}
    </div>
  )
}

const FRAME_MS = 16

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('meterFill', () => {
  it('draws decibels: silence empty, -30 dBFS half, full scale full', () => {
    expect(meterFill(0)).toBe(0)
    expect(meterFill(0.001)).toBeCloseTo(0)
    expect(meterFill(10 ** (-30 / 20))).toBeCloseTo(0.5)
    expect(meterFill(1)).toBe(1)
    expect(meterFill(2)).toBe(1)
    expect(meterTransform(0.5)).toBe('scaleX(0.5)')
  })
})

describe('useMicActivity', () => {
  it('fills the meter on each frame, and rings the face while the level is at speaking, for a hold', () => {
    let level = 0
    const view = render(<Probe level={() => level} active />)
    const fill = view.getByTestId('fill')
    const face = view.getByTestId('face')
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(fill.style.transform).toBe('scaleX(0)')
    expect(face).not.toHaveAttribute('data-speaking')

    // -30 dBFS, a voice: half the bar, on the decibel scale.
    level = 10 ** (-30 / 20)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(fill.style.transform).toBe('scaleX(0.5)')
    level = 1
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(fill.style.transform).toBe('scaleX(1)')
    expect(face).toHaveAttribute('data-speaking', '')

    // Just under the threshold: still ringing within the hold, then not.
    level = SPEAKING_LEVEL * 0.9
    act(() => void vi.advanceTimersByTime(SPEAKING_HOLD_MS - 2 * FRAME_MS))
    expect(face).toHaveAttribute('data-speaking')
    act(() => void vi.advanceTimersByTime(3 * FRAME_MS))
    expect(face).not.toHaveAttribute('data-speaking')
    expect(fill.style.transform).not.toBe('scaleX(0)')
  })

  it("draws the settings panel's meter the same, from the frame after it opens", () => {
    let level = 0
    const view = render(<Probe level={() => level} active />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    view.rerender(<Probe level={() => level} active panel />)
    level = 1
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('panel-fill').style.transform).toBe('scaleX(1)')
    expect(view.getByTestId('fill').style.transform).toBe('scaleX(1)')
    // Closed again: the dock's meter goes on.
    view.rerender(<Probe level={() => level} active />)
    level = 10 ** (-30 / 20)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('fill').style.transform).toBe('scaleX(0.5)')
  })

  it('draws without rendering: a voice starting and stopping re-renders nothing', () => {
    let level = 0
    const rendered = vi.fn()
    render(
      <Profiler id="probe" onRender={rendered}>
        <Probe level={() => level} active />
      </Profiler>
    )
    rendered.mockClear()
    for (let index = 0; index < 6; index += 1) {
      level = index % 2 === 0 ? 1 : 0
      act(() => void vi.advanceTimersByTime(SPEAKING_HOLD_MS + FRAME_MS))
    }
    expect(rendered).not.toHaveBeenCalled()
  })

  it('reads nothing, an empty meter and no ring, when not active', () => {
    const level = vi.fn(() => 1)
    const view = render(<Probe level={level} active />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('face')).toHaveAttribute('data-speaking')

    view.rerender(<Probe level={level} active={false} />)
    level.mockClear()
    act(() => void vi.advanceTimersByTime(10 * FRAME_MS))
    expect(level).not.toHaveBeenCalled()
    expect(view.getByTestId('fill').style.transform).toBe('scaleX(0)')
    expect(view.getByTestId('face')).not.toHaveAttribute('data-speaking')
  })

  it('takes the ring off a face no longer handed to it, as when the member leaves the call', () => {
    const view = render(<Probe level={() => 1} active />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    const face = view.getByTestId('face')
    expect(face).toHaveAttribute('data-speaking')
    // The same face, in a room the member has left: its ref is gone before the effect ends.
    view.rerender(<Probe level={() => 1} active={false} ringable={false} />)
    expect(face).not.toHaveAttribute('data-speaking')
  })

  it('moves the ring to the face it is handed now, and off the one before', () => {
    // One level throughout: the effect keeps running while the face it is handed changes.
    const loud = () => 1
    function Swap({ first }: { first: boolean }) {
      const { speakingRef } = useMicActivity(loud, true)
      return (
        <div>
          <span data-testid="a" ref={first ? speakingRef : undefined} />
          <span data-testid="b" ref={first ? undefined : speakingRef} />
        </div>
      )
    }
    const view = render(<Swap first />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('a')).toHaveAttribute('data-speaking')
    view.rerender(<Swap first={false} />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('a')).not.toHaveAttribute('data-speaking')
    expect(view.getByTestId('b')).toHaveAttribute('data-speaking')
  })

  it('stops reading once unmounted', () => {
    const level = vi.fn(() => 1)
    const view = render(<Probe level={level} active />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    view.unmount()
    level.mockClear()
    vi.advanceTimersByTime(10 * FRAME_MS)
    expect(level).not.toHaveBeenCalled()
  })

  it('does nothing for a call that has no level to read', () => {
    const view = render(<Probe level={undefined} active />)
    act(() => void vi.advanceTimersByTime(FRAME_MS))
    expect(view.getByTestId('face')).not.toHaveAttribute('data-speaking')
  })
})

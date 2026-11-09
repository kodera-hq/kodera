// The member's own microphone, frame by frame: a meter's fill and the speaking ring on their own
// face (spec 11, « Hearing yourself in an audio room »). The level is read from the call
// (`CallController.micLevel`), in this browser, so both move when the member is alone in the room.
// Both are drawn on their elements directly: nothing re-renders at the voice's pace.

import { useEffect, useRef, type RefObject } from 'react'

/** The RMS level above which the member is speaking: about -34 dBFS, above a quiet room's hum. */
export const SPEAKING_LEVEL = 0.02
/** How long the ring stays after the voice drops, so it does not flicker between words. */
export const SPEAKING_HOLD_MS = 300
/** The quietest level the meter draws: -60 dBFS is an empty bar, 0 dBFS a full one. */
const FLOOR_DB = -60

/** The meter's fill for a level, 0 to 1, on a decibel scale: speech fills about half of it. */
export function meterFill(level: number): number {
  if (level <= 0) return 0
  const db = 20 * Math.log10(level)
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB))
}

/** The meter fill's transform for a level: a scale, so a frame moves no layout. */
export function meterTransform(fill: number): string {
  return `scaleX(${Math.round(fill * 100) / 100})`
}

export interface MicActivity {
  /** Give it to the meter's fill: its transform is set on every frame. */
  meterRef: RefObject<HTMLSpanElement | null>
  /** The audio settings' own meter, drawn the same, while the panel is open. */
  panelMeterRef: RefObject<HTMLSpanElement | null>
  /** Give it to the member's own face: it carries `data-speaking` while they speak. */
  speakingRef: RefObject<HTMLElement | null>
}

/**
 * Reads `level` on every animation frame while `active`, and stops when it is not: out of a call,
 * or muted, the meter is empty and the ring is off.
 */
export function useMicActivity(level: (() => number) | undefined, active: boolean): MicActivity {
  const meterRef = useRef<HTMLSpanElement | null>(null)
  const panelMeterRef = useRef<HTMLSpanElement | null>(null)
  const speakingRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    // The face this effect rang, kept apart from the ref: leaving a call takes the ref off the
    // face before this effect's cleanup runs, and the ring must not stay on it.
    let ringed: HTMLElement | null = null
    const draw = (fill: number, speaking: boolean) => {
      const transform = meterTransform(fill)
      if (meterRef.current !== null) meterRef.current.style.transform = transform
      if (panelMeterRef.current !== null) panelMeterRef.current.style.transform = transform
      const face = speaking ? speakingRef.current : null
      if (face === ringed) return
      ringed?.removeAttribute('data-speaking')
      face?.setAttribute('data-speaking', '')
      ringed = face
    }
    if (!active || level === undefined) {
      draw(0, false)
      return
    }
    let frame = 0
    let lastVoice = Number.NEGATIVE_INFINITY
    const tick = (now: number) => {
      const current = level()
      if (current >= SPEAKING_LEVEL) lastVoice = now
      draw(meterFill(current), now - lastVoice < SPEAKING_HOLD_MS)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      draw(0, false)
    }
  }, [level, active])

  return { meterRef, panelMeterRef, speakingRef }
}

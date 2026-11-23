import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { SoundEngine } from './SoundEngine'
import {
  SOUNDBOARD_COOLDOWN_MS,
  SoundboardPopover,
  WAITING_AMBIENCE_DUCK_GAIN,
  WaitingRoomAmbienceController,
  computeLufsNormalizationGain,
} from './SoundboardPopover'

describe('SoundboardPopover & WaitingRoomAmbienceController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('plays procedural cues through SoundEngine when !listenOnly && !deafened and enforces 5s anti-spam cooldown + local mute', () => {
    vi.useFakeTimers()
    const play = vi.fn()
    const fakeEngine = { play } as unknown as SoundEngine

    render(
      <SoundboardPopover
        roomId="!voice:acme.kodera.io"
        listenOnly={false}
        deafened={false}
        engine={fakeEngine}
      />
    )

    const trigger = screen.getByTestId('audio-dock-soundboard-trigger')
    expect(trigger).not.toBeDisabled()
    expect(trigger.textContent?.trim()).toBe('')

    fireEvent.click(trigger)
    expect(screen.getByTestId('audio-dock-soundboard-popover')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('soundboard-cue-hand-raise'))
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith('voice_hand_raise', {
      activeVoiceCall: true,
      roomId: '!voice:acme.kodera.io',
    })

    // Re-open while 5s cooldown is active: cue buttons are disabled until 5_000 ms elapses
    fireEvent.click(trigger)
    expect(screen.getByTestId('soundboard-cooldown-status')).toBeInTheDocument()
    expect(screen.getByTestId('soundboard-cue-knock')).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(SOUNDBOARD_COOLDOWN_MS)
    })
    expect(screen.queryByTestId('soundboard-cooldown-status')).toBeNull()
    expect(screen.getByTestId('soundboard-cue-knock')).not.toBeDisabled()

    // Per-user local mute toggle mutes cues locally
    fireEvent.click(screen.getByTestId('soundboard-local-mute-toggle'))
    expect(screen.getByTestId('soundboard-cue-knock')).toBeDisabled()
  })

  it('disables soundboard trigger when listenOnly or deafened', () => {
    const play = vi.fn()
    const fakeEngine = { play } as unknown as SoundEngine

    const { rerender } = render(
      <SoundboardPopover listenOnly deafened={false} engine={fakeEngine} />
    )
    expect(screen.getByTestId('audio-dock-soundboard-trigger')).toBeDisabled()

    rerender(<SoundboardPopover listenOnly={false} deafened engine={fakeEngine} />)
    expect(screen.getByTestId('audio-dock-soundboard-trigger')).toBeDisabled()
    expect(play).not.toHaveBeenCalled()
  })

  it('normalizes custom soundboard loudness toward -16 LUFS and auto-ducks waiting-room ambience on speech', () => {
    // Full-scale hot signal (~0 dBFS) is attenuated below 1.0, quiet signal is boosted within [0.1, 4].
    const hot = new Float32Array(256).fill(0.95)
    const quiet = new Float32Array(256).fill(0.02)
    expect(computeLufsNormalizationGain(hot)).toBeLessThan(0.3)
    expect(computeLufsNormalizationGain(quiet)).toBeGreaterThan(1.5)
    expect(computeLufsNormalizationGain(quiet)).toBeLessThanOrEqual(4)

    const setTargetAtTime = vi.fn()
    const closeSpy = vi.fn(async () => undefined)
    const gainParam = { value: 1, setTargetAtTime }
    const fakeCtx = {
      currentTime: 2.5,
      destination: {},
      createGain: () => ({ gain: gainParam, connect: vi.fn(), disconnect: vi.fn() }),
      createOscillator: () => ({
        type: 'sine',
        frequency: { value: 220 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }),
      close: closeSpy,
    } as unknown as AudioContext

    const ambience = new WaitingRoomAmbienceController(() => fakeCtx)
    expect(ambience.start()).toBe(true)
    expect(ambience.currentGain).toBe(1)

    ambience.duckForSpeech(true)
    expect(ambience.isDucked).toBe(true)
    expect(ambience.currentGain).toBe(WAITING_AMBIENCE_DUCK_GAIN)
    expect(setTargetAtTime).toHaveBeenCalledWith(WAITING_AMBIENCE_DUCK_GAIN, 2.5, 0.08)

    ambience.duckForSpeech(false)
    expect(ambience.isDucked).toBe(false)
    expect(ambience.currentGain).toBe(1)

    ambience.stop()
    expect(ambience.isActive).toBe(false)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

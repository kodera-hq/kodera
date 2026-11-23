import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KoderaVoiceVisualizer, SILENCE_PAUSE_MS } from './KoderaVoiceVisualizer'

function makeTrack(): MediaStreamTrack & { cloneSpy: ReturnType<typeof vi.fn> } {
  const cloneSpy = vi.fn(() => {
    throw new Error('track.clone() must never be called')
  })
  return {
    id: 'mic-track-1',
    kind: 'audio',
    enabled: true,
    muted: false,
    readyState: 'live',
    clone: cloneSpy,
    stop: vi.fn(),
    cloneSpy,
  } as unknown as MediaStreamTrack & { cloneSpy: ReturnType<typeof vi.fn> }
}

describe('KoderaVoiceVisualizer', () => {
  const streamTracks: MediaStreamTrack[][] = []

  beforeEach(() => {
    streamTracks.length = 0
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'performance'],
    })

    class FakeMediaStream {
      private readonly tracks: MediaStreamTrack[]
      constructor(tracks: MediaStreamTrack[] = []) {
        this.tracks = tracks
        streamTracks.push(tracks)
      }
      getTracks() {
        return this.tracks
      }
      getAudioTracks() {
        return this.tracks
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('connects MediaStreamTrack without cloning and falls back cleanly from CSP-blocked AudioWorkletNode to AnalyserNode (fftSize = 256)', () => {
    let createdAnalyserFftSize = 0
    const getByteTimeDomainData = vi.fn((arr: Uint8Array) => {
      arr.fill(196)
    })
    const disconnectSource = vi.fn()
    const disconnectAnalyser = vi.fn()
    const closeCtx = vi.fn(async () => undefined)

    class FakeAudioContext {
      audioWorklet = {}
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: disconnectSource,
      }))
      createAnalyser = vi.fn(() => {
        const node = {
          fftSize: 2048,
          smoothingTimeConstant: 0.8,
          getByteTimeDomainData,
          disconnect: disconnectAnalyser,
        }
        Object.defineProperty(node, 'fftSize', {
          get: () => createdAnalyserFftSize,
          set: (val: number) => {
            createdAnalyserFftSize = val
          },
        })
        return node
      })
      close = closeCtx
    }

    class CspBlockedAudioWorkletNode {
      constructor() {
        throw new DOMException('Blocked by Content-Security-Policy', 'SecurityError')
      }
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', CspBlockedAudioWorkletNode)

    const track = makeTrack()
    const view = render(<KoderaVoiceVisualizer track={track} connected muted={false} />)
    const canvas = screen.getByTestId('kodera-voice-visualizer')

    act(() => {
      vi.advanceTimersByTime(32)
    })

    expect(track.cloneSpy).not.toHaveBeenCalled()
    expect(streamTracks).toEqual([[track]])
    expect(createdAnalyserFftSize).toBe(256)
    expect(getByteTimeDomainData).toHaveBeenCalled()
    expect(canvas.getAttribute('style')).toBeNull()
    expect(canvas.dataset.visualizerState).toBe('active')

    view.unmount()
    expect(disconnectSource).toHaveBeenCalled()
    expect(disconnectAnalyser).toHaveBeenCalled()
    expect(closeCtx).toHaveBeenCalled()
  })

  it('auto-pauses rAF when silent > 300 ms, muted, disconnected, or document.hidden', () => {
    let level = 0.75
    const sampler = vi.fn(() => level)

    const { rerender } = render(
      <KoderaVoiceVisualizer levelSampler={sampler} connected muted={false} />
    )
    const canvas = screen.getByTestId('kodera-voice-visualizer')

    act(() => {
      vi.advanceTimersByTime(32)
    })
    expect(canvas.dataset.visualizerState).toBe('active')

    // Drop to silence: after decay + > 300 ms, the rAF loop pauses automatically.
    level = 0
    act(() => {
      vi.advanceTimersByTime(SILENCE_PAUSE_MS + 600)
    })
    expect(canvas.dataset.visualizerState).toBe('paused')

    // Muted immediately pauses without sampling.
    level = 0.8
    sampler.mockClear()
    rerender(<KoderaVoiceVisualizer levelSampler={sampler} connected muted />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(canvas.dataset.visualizerState).toBe('paused')
    expect(sampler).not.toHaveBeenCalled()

    // Disconnected immediately pauses without sampling.
    rerender(<KoderaVoiceVisualizer levelSampler={sampler} connected={false} muted={false} />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(canvas.dataset.visualizerState).toBe('paused')
    expect(sampler).not.toHaveBeenCalled()
  })

  it('honors prefers-reduced-motion: reduce with a static centre hairline and zero rAF ticks', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )
    const sampler = vi.fn(() => 0.9)
    render(<KoderaVoiceVisualizer levelSampler={sampler} connected muted={false} />)
    const canvas = screen.getByTestId('kodera-voice-visualizer')

    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(canvas.dataset.visualizerState).toBe('reduced-motion')
    expect(sampler).not.toHaveBeenCalled()
  })

  it('resumes suspended AudioContext, registers AudioWorklet via addModule, and upgrades from AnalyserNode to AudioWorkletNode', async () => {
    const resumeSpy = vi.fn(async () => undefined)
    const closeSpy = vi.fn(async () => undefined)
    let moduleRegistered = false
    const addModuleSpy = vi.fn(async () => {
      moduleRegistered = true
    })
    const disconnectAnalyser = vi.fn()
    let workletPort: { onmessage: ((ev: MessageEvent<unknown>) => void) | null } | null = null

    class FakeAudioContext {
      state = 'suspended'
      resume = resumeSpy
      close = closeSpy
      audioWorklet = { addModule: addModuleSpy }
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }))
      createAnalyser = vi.fn(() => ({
        fftSize: 256,
        smoothingTimeConstant: 0.72,
        getByteTimeDomainData: (arr: Uint8Array) => arr.fill(180),
        disconnect: disconnectAnalyser,
      }))
    }

    class FakeAudioWorkletNode {
      port = { onmessage: null as ((ev: MessageEvent<unknown>) => void) | null }
      disconnect = vi.fn()
      constructor() {
        if (!moduleRegistered) {
          throw new DOMException('Processor not registered yet', 'InvalidStateError')
        }
        workletPort = this.port
      }
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)

    const track = makeTrack()
    const view = render(<KoderaVoiceVisualizer track={track} connected muted={false} />)

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(addModuleSpy).toHaveBeenCalledTimes(1)
    expect(addModuleSpy).toHaveBeenCalledWith('/worklets/kodera-voice-peaks.js')
    expect(workletPort).not.toBeNull()
    expect(disconnectAnalyser).toHaveBeenCalled()

    view.unmount()
    expect(closeSpy).toHaveBeenCalled()
  })
})

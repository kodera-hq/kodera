// Signature Cobalt Linear Dark Precision microphone visualizer.
// Connects MediaStreamTrack directly via new MediaStream([track]), never cloning tracks so the OS
// microphone indicator releases cleanly. Registers the static same-origin AudioWorklet module
// (`/worklets/kodera-voice-peaks.js`) respecting strict `worker-src 'self'` CSP, while sampling
// AnalyserNode (fftSize = 256) immediately from frame 1 and falling back cleanly without throwing.
// Pre-allocates a single Float32Array(32) outside requestAnimationFrame for zero per-frame heap
// allocations, pauses rAF when muted, disconnected, hidden, or silent over 300 ms, and draws a
// static centre hairline when prefers-reduced-motion is enabled.

import { useEffect, useRef } from 'react'
import { cx } from '../../../ui/cx'

export const VISUALIZER_BAR_COUNT = 32
export const SILENCE_PAUSE_MS = 300
export const VOICE_PEAKS_WORKLET_URL = '/worklets/kodera-voice-peaks.js'
const SILENCE_EPSILON = 0.012
const WAKE_PROBE_INTERVAL_MS = 180
const registeredWorkletContexts = new WeakSet<AudioContext>()

export interface KoderaVoiceVisualizerProps {
  readonly track?: MediaStreamTrack | null | undefined
  readonly trackSource?: (() => MediaStreamTrack | null) | undefined
  readonly levelSampler?: (() => number) | undefined
  readonly workletUrl?: string | undefined
  readonly muted?: boolean | undefined
  readonly connected?: boolean | undefined
  readonly surface?: 'inverse' | 'light' | undefined
  readonly compact?: boolean | undefined
  readonly testId?: string | undefined
}

interface PaletteTokens {
  accent: string
  peak: string
  hairline: string
}

function readPaletteTokens(canvas: HTMLCanvasElement, surface: 'inverse' | 'light'): PaletteTokens {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { accent: 'currentColor', peak: 'currentColor', hairline: 'currentColor' }
  }
  const style = window.getComputedStyle(canvas)
  const accent =
    style.getPropertyValue(surface === 'inverse' ? '--c-accent-ink' : '--c-action').trim() ||
    'currentColor'
  const peak =
    style.getPropertyValue(surface === 'inverse' ? '--c-on-inverse' : '--c-accent-ink').trim() ||
    accent
  const hairline =
    style
      .getPropertyValue(surface === 'inverse' ? '--c-on-inverse-dim' : '--c-border')
      .trim() || accent
  return { accent, peak, hairline }
}

function queryReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

function createAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (typeof Ctor !== 'function') return null
  try {
    return new Ctor()
  } catch {
    return null
  }
}

function drawStaticHairline(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  palette: PaletteTokens
): void {
  if (ctx === null || width <= 0 || height <= 0) return
  ctx.clearRect(0, 0, width, height)
  const midY = Math.round(height * 0.5)
  ctx.save()
  ctx.globalAlpha = 0.42
  ctx.fillStyle = palette.hairline
  ctx.fillRect(0, Math.max(0, midY - 0.5), width, 1)
  ctx.restore()
}

export function KoderaVoiceVisualizer({
  track,
  trackSource,
  levelSampler,
  workletUrl = VOICE_PEAKS_WORKLET_URL,
  muted = false,
  connected = true,
  surface = 'inverse',
  compact = false,
  testId = 'kodera-voice-visualizer',
}: KoderaVoiceVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Pre-allocated buffers reused across all animation frames with zero per-frame allocations.
  const barsRef = useRef<Float32Array>(new Float32Array(VISUALIZER_BAR_COUNT))
  const workletBinsRef = useRef<Float32Array>(new Float32Array(VISUALIZER_BAR_COUNT))
  const timeDomainRef = useRef<Uint8Array<ArrayBuffer>>(
    new Uint8Array(new ArrayBuffer(256))
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return

    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }

    const palette = readPaletteTokens(canvas, surface)
    const bars = barsRef.current
    const workletBins = workletBinsRef.current
    const timeDomain = timeDomainRef.current
    bars.fill(0)
    workletBins.fill(0)

    let reducedMotion = queryReducedMotion()
    let mediaQuery: MediaQueryList | null = null
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try {
        mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
      } catch {
        mediaQuery = null
      }
    }

    let rafId = 0
    let probeTimer: ReturnType<typeof setInterval> | null = null
    let lastActiveTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let workletReady = false
    let disposed = false

    let audioCtx: AudioContext | null = null
    let sourceNode: MediaStreamAudioSourceNode | null = null
    let analyserNode: AnalyserNode | null = null
    let workletNode: AudioWorkletNode | null = null
    let attachedTrack: MediaStreamTrack | null = null

    const disconnectNodes = () => {
      workletReady = false
      if (workletNode !== null) {
        try {
          workletNode.port.onmessage = null
          workletNode.disconnect()
        } catch {
          // Best-effort node teardown.
        }
        workletNode = null
      }
      if (analyserNode !== null) {
        try {
          analyserNode.disconnect()
        } catch {
          // Best-effort node teardown.
        }
        analyserNode = null
      }
      if (sourceNode !== null) {
        try {
          sourceNode.disconnect()
        } catch {
          // Best-effort node teardown.
        }
        sourceNode = null
      }
      attachedTrack = null
    }

    const stopLoop = () => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const renderHairline = () => {
      canvas.dataset.visualizerState = reducedMotion ? 'reduced-motion' : 'paused'
      drawStaticHairline(ctx, canvas.width, canvas.height, palette)
    }

    const resolveLiveTrack = (): MediaStreamTrack | null => {
      const candidate = track !== undefined ? track : (trackSource?.() ?? null)
      if (candidate === null || candidate.readyState === 'ended') return null
      return candidate
    }

    const attachAudioGraph = (nextTrack: MediaStreamTrack | null) => {
      if (nextTrack === attachedTrack) return
      disconnectNodes()
      if (nextTrack === null || typeof MediaStream === 'undefined') return
      audioCtx ??= createAudioContext()
      if (audioCtx === null) return
      const activeAudioCtx = audioCtx
      if (activeAudioCtx.state !== 'running' && typeof activeAudioCtx.resume === 'function') {
        void activeAudioCtx
          .resume()
          .then(() => {
            if (disposed && typeof activeAudioCtx.close === 'function') {
              void activeAudioCtx.close().catch(() => {})
            }
          })
          .catch(() => {})
      }

      let activeSource: MediaStreamAudioSourceNode
      try {
        // Wrap directly in MediaStream without track.clone() so OS mic indicator never sticks.
        const stream = new MediaStream([nextTrack])
        activeSource = activeAudioCtx.createMediaStreamSource(stream)
        sourceNode = activeSource
        attachedTrack = nextTrack
      } catch {
        disconnectNodes()
        return
      }

      // Connect AnalyserNode immediately so frame-1 sampling works seamlessly, then upgrade to the
      // same-origin AudioWorkletNode once `audioWorklet.addModule(workletUrl)` resolves.
      try {
        const analyser = activeAudioCtx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.72
        activeSource.connect(analyser)
        analyserNode = analyser
      } catch {
        analyserNode = null
      }

      const mountWorkletNode = (): boolean => {
        try {
          const node = new AudioWorkletNode(activeAudioCtx, 'kodera-voice-peaks')
          node.port.onmessage = (event: MessageEvent<unknown>) => {
            const data = event.data
            if (data instanceof Float32Array) {
              const limit = Math.min(VISUALIZER_BAR_COUNT, data.length)
              let peak = 0
              for (let i = 0; i < limit; i += 1) {
                const v = data[i] ?? 0
                workletBins[i] = v
                if (v > peak) peak = v
              }
              workletReady = true
              if (peak > SILENCE_EPSILON) {
                lastActiveTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
                ensureLoop()
              }
            }
          }
          activeSource.connect(node)
          workletNode = node
          if (analyserNode !== null) {
            try {
              analyserNode.disconnect()
            } catch {
              // Best-effort analyser handoff.
            }
            analyserNode = null
          }
          return true
        } catch {
          return false
        }
      }

      if (typeof AudioWorkletNode === 'function' && activeAudioCtx.audioWorklet !== undefined) {
        if (registeredWorkletContexts.has(activeAudioCtx)) {
          mountWorkletNode()
        } else if (typeof activeAudioCtx.audioWorklet.addModule === 'function' && workletUrl) {
          void activeAudioCtx.audioWorklet
            .addModule(workletUrl)
            .then(() => {
              registeredWorkletContexts.add(activeAudioCtx)
              if (!disposed && attachedTrack === nextTrack && sourceNode === activeSource) {
                mountWorkletNode()
              }
            })
            .catch(() => {})
        } else {
          mountWorkletNode()
        }
      }
    }

    const canAnimate = (): boolean => {
      if (disposed || reducedMotion || muted || !connected) return false
      if (
        typeof document !== 'undefined' &&
        (document.hidden || document.visibilityState === 'hidden')
      ) {
        return false
      }
      return true
    }

    const sampleEnergy = (): number => {
      const liveTrack = resolveLiveTrack()
      if (liveTrack !== attachedTrack) {
        attachAudioGraph(liveTrack)
      }

      let maxPeak = 0
      if (workletReady && workletNode !== null) {
        for (let i = 0; i < VISUALIZER_BAR_COUNT; i += 1) {
          const target = Math.min(1, Math.max(0, workletBins[i] ?? 0))
          const smoothed = bars[i]! * 0.62 + target * 0.38
          bars[i] = smoothed
          if (smoothed > maxPeak) maxPeak = smoothed
        }
        return maxPeak
      }

      if (analyserNode !== null) {
        analyserNode.getByteTimeDomainData(timeDomain)
        const stride = 8
        for (let b = 0; b < VISUALIZER_BAR_COUNT; b += 1) {
          const offset = b * stride
          let sumSq = 0
          for (let j = 0; j < stride; j += 1) {
            const centered = ((timeDomain[offset + j] ?? 128) - 128) / 128
            sumSq += centered * centered
          }
          const rms = Math.min(1, Math.sqrt(sumSq / stride) * 3.2)
          const smoothed = bars[b]! * 0.6 + rms * 0.4
          bars[b] = smoothed
          if (smoothed > maxPeak) maxPeak = smoothed
        }
        return maxPeak
      }

      const fallbackLevel = levelSampler ? Math.min(1, Math.max(0, levelSampler())) : 0
      const center = (VISUALIZER_BAR_COUNT - 1) * 0.5
      for (let b = 0; b < VISUALIZER_BAR_COUNT; b += 1) {
        const distance = Math.abs(b - center) / center
        const envelope = Math.max(0.18, 1 - distance * 0.78)
        const target = fallbackLevel * envelope
        const smoothed = bars[b]! * 0.6 + target * 0.4
        bars[b] = smoothed
        if (smoothed > maxPeak) maxPeak = smoothed
      }
      return maxPeak
    }

    const frame = (timestamp: number) => {
      rafId = 0
      if (!canAnimate()) {
        renderHairline()
        return
      }

      const energy = sampleEnergy()
      const now = timestamp > 0 ? timestamp : Date.now()
      if (energy > SILENCE_EPSILON) {
        lastActiveTime = now
      } else if (now - lastActiveTime > SILENCE_PAUSE_MS) {
        bars.fill(0)
        renderHairline()
        return
      }

      if (ctx !== null) {
        const width = canvas.width
        const height = canvas.height
        ctx.clearRect(0, 0, width, height)
        const midY = height * 0.5
        ctx.save()
        ctx.globalAlpha = 0.28
        ctx.fillStyle = palette.hairline
        ctx.fillRect(0, Math.max(0, Math.round(midY) - 0.5), width, 1)

        const slotWidth = width / VISUALIZER_BAR_COUNT
        const barWidth = Math.max(1.5, slotWidth * 0.58)
        const gapOffset = (slotWidth - barWidth) * 0.5
        for (let i = 0; i < VISUALIZER_BAR_COUNT; i += 1) {
          const amp = bars[i]!
          const barHeight = Math.max(1.5, amp * (height - 2))
          const x = i * slotWidth + gapOffset
          const y = midY - barHeight * 0.5
          ctx.globalAlpha = 0.45 + Math.min(0.55, amp * 0.75)
          ctx.fillStyle = amp > 0.68 ? palette.peak : palette.accent
          ctx.fillRect(x, y, barWidth, barHeight)
        }
        ctx.restore()
      }

      canvas.dataset.visualizerState = 'active'
      rafId = requestAnimationFrame(frame)
    }

    function ensureLoop(): void {
      if (rafId !== 0 || !canAnimate()) return
      lastActiveTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
      rafId = requestAnimationFrame(frame)
    }

    attachAudioGraph(resolveLiveTrack())

    if (!canAnimate()) {
      renderHairline()
    } else {
      ensureLoop()
      // Lightweight idle wake probe so silence-paused AnalyserNode / sampler wakes on speech.
      probeTimer = setInterval(() => {
        if (rafId !== 0 || !canAnimate()) return
        const energy = sampleEnergy()
        if (energy > SILENCE_EPSILON) {
          ensureLoop()
        }
      }, WAKE_PROBE_INTERVAL_MS)
    }

    const handleVisibilityChange = () => {
      if (!canAnimate()) {
        stopLoop()
        renderHairline()
      } else {
        ensureLoop()
      }
    }

    const handleMotionChange = (event?: MediaQueryListEvent) => {
      reducedMotion =
        typeof event?.matches === 'boolean' ? event.matches : Boolean(mediaQuery?.matches)
      if (!canAnimate()) {
        stopLoop()
        renderHairline()
      } else {
        ensureLoop()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (mediaQuery !== null && typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMotionChange)
    }

    return () => {
      disposed = true
      stopLoop()
      if (probeTimer !== null) {
        clearInterval(probeTimer)
        probeTimer = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (mediaQuery !== null && typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMotionChange)
      }
      disconnectNodes()
      if (audioCtx !== null && typeof audioCtx.close === 'function') {
        void audioCtx.close().catch(() => {})
        audioCtx = null
      }
    }
  }, [track, trackSource, levelSampler, workletUrl, muted, connected, surface])

  return (
    <canvas
      ref={canvasRef}
      width={160}
      height={compact ? 10 : 16}
      aria-hidden="true"
      data-testid={testId}
      data-visualizer-surface={surface}
      className={cx(
        'block w-full rounded-sm',
        surface === 'inverse' ? 'bg-c-inverse-2' : 'bg-c-muted',
        compact ? 'h-2' : 'h-4'
      )}
    />
  )
}

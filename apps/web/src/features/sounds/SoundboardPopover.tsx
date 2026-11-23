// Compact procedural & customizable Soundboard popover for AudioDock (`studio` layout), backed by
// SoundEngine.ts and Web Audio `-16 LUFS` loudness normalization, `5s` anti-spam cooldown,
// per-user local mute, and waiting-room ambience speech auto-ducking.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { EspaceGlyph } from '../../ui/icons/EspaceGlyph'
import { Popover } from '../../ui/Popover/Popover'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { soundEngine, type SoundEngine } from './SoundEngine'
import type { SemanticTriggerId } from './types'

export const SOUNDBOARD_TARGET_LUFS = -16
export const SOUNDBOARD_COOLDOWN_MS = 5_000
export const WAITING_AMBIENCE_DUCK_GAIN = 0.18

/**
 * Estimates integrated loudness (ITU-R BS.1770 energy approximation) and returns a clamped linear
 * Web Audio GainNode multiplier targeting `-16 LUFS` so custom soundboard clips never clip or blast.
 */
export function computeLufsNormalizationGain(
  samples: Float32Array,
  targetLufs: number = SOUNDBOARD_TARGET_LUFS
): number {
  if (samples.length === 0) return 1
  let sumSq = 0
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0
    sumSq += s * s
  }
  const meanSquare = Math.max(1e-9, sumSq / samples.length)
  const measuredLufs = -0.691 + 10 * Math.log10(meanSquare)
  const deltaDb = targetLufs - measuredLufs
  const linearGain = 10 ** (deltaDb / 20)
  return Math.max(0.1, Math.min(4, linearGain))
}

/**
 * Waiting-room ambience controller with smooth speech auto-ducking (`duckForSpeech(speaking)`)
 * and deterministic Web Audio teardown on unmount.
 */
export class WaitingRoomAmbienceController {
  #ctx: AudioContext | null = null
  #gainNode: GainNode | null = null
  #oscNode: OscillatorNode | null = null
  #ducked = false
  #active = false

  constructor(private readonly contextFactory?: () => AudioContext | null) {}

  get isActive(): boolean {
    return this.#active
  }

  get isDucked(): boolean {
    return this.#ducked
  }

  get currentGain(): number {
    return this.#gainNode?.gain.value ?? (this.#ducked ? WAITING_AMBIENCE_DUCK_GAIN : 1)
  }

  start(): boolean {
    if (this.#active) return true
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined
    const ctx =
      this.contextFactory !== undefined
        ? this.contextFactory()
        : typeof Ctor === 'function'
          ? new Ctor()
          : null
    if (ctx === null) return false
    try {
      const gain = ctx.createGain()
      gain.gain.value = this.#ducked ? WAITING_AMBIENCE_DUCK_GAIN : 1
      gain.connect(ctx.destination)
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = 220
      osc.connect(gain)
      osc.start()
      this.#ctx = ctx
      this.#gainNode = gain
      this.#oscNode = osc
      this.#active = true
      return true
    } catch {
      void ctx.close?.().catch(() => {})
      return false
    }
  }

  duckForSpeech(speaking: boolean): void {
    this.#ducked = speaking
    if (this.#gainNode === null) return
    const target = speaking ? WAITING_AMBIENCE_DUCK_GAIN : 1
    const param = this.#gainNode.gain
    if (typeof param.setTargetAtTime === 'function' && this.#ctx !== null) {
      param.setTargetAtTime(target, this.#ctx.currentTime, 0.08)
    }
    param.value = target
  }

  stop(): void {
    this.#active = false
    if (this.#oscNode !== null) {
      try {
        this.#oscNode.stop()
        this.#oscNode.disconnect()
      } catch {
        // Best-effort oscillator teardown.
      }
      this.#oscNode = null
    }
    if (this.#gainNode !== null) {
      try {
        this.#gainNode.disconnect()
      } catch {
        // Best-effort gain teardown.
      }
      this.#gainNode = null
    }
    if (this.#ctx !== null) {
      void this.#ctx.close?.().catch(() => {})
      this.#ctx = null
    }
  }
}

export interface CustomSoundboardClip {
  readonly id: string
  readonly label: string
  readonly buffer: AudioBuffer
  readonly senderId?: string | undefined
}

interface SoundboardCueItem {
  readonly id: string
  readonly trigger: SemanticTriggerId
  readonly fr: string
  readonly en: string
}

export const SOUNDBOARD_CUES: readonly SoundboardCueItem[] = [
  {
    id: 'hand-raise',
    trigger: 'voice_hand_raise',
    fr: 'Lever la main',
    en: 'Raise hand',
  },
  {
    id: 'knock',
    trigger: 'voice_guest_knock',
    fr: 'Toquer au salon',
    en: 'Room knock',
  },
  {
    id: 'ready',
    trigger: 'call_restored',
    fr: 'Signal prêt',
    en: 'Ready chime',
  },
  {
    id: 'agenda',
    trigger: 'workspace_agenda_reminder',
    fr: 'Point suivant',
    en: 'Next topic',
  },
] as const

const COPY = {
  fr: {
    triggerLabel: 'Palette sonore',
    disabledLabel: 'Palette sonore indisponible (écoute seule ou son coupé)',
    heading: 'Signaux sonores',
    cooldownNotice: 'Pause anti-bruit (5 s)…',
    muteSelfOn: ' Palette muette localement',
    muteSelfOff: 'Couper localement',
  },
  en: {
    triggerLabel: 'Soundboard',
    disabledLabel: 'Soundboard unavailable (listen-only or deafened)',
    heading: 'Sound cues',
    cooldownNotice: 'Cooldown active (5s)…',
    muteSelfOn: 'Locally muted',
    muteSelfOff: 'Mute locally',
  },
} as const

export interface SoundboardPopoverProps {
  readonly roomId?: string | null | undefined
  readonly listenOnly?: boolean | undefined
  readonly deafened?: boolean | undefined
  readonly engine?: SoundEngine | undefined
  readonly customClips?: readonly CustomSoundboardClip[] | undefined
  readonly mutedUserIds?: ReadonlySet<string> | undefined
  readonly audioContextFactory?: (() => AudioContext | null) | undefined
}

export function SoundboardPopover({
  roomId,
  listenOnly = false,
  deafened = false,
  engine = soundEngine,
  customClips = [],
  mutedUserIds,
  audioContextFactory,
}: SoundboardPopoverProps) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = COPY[locale]
  const [open, setOpen] = useState(false)
  const [localMuted, setLocalMuted] = useState(false)
  const [onCooldown, setOnCooldown] = useState(false)

  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const customCtxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current)
        cooldownTimerRef.current = null
      }
      if (customCtxRef.current !== null) {
        void customCtxRef.current.close?.().catch(() => {})
        customCtxRef.current = null
      }
    }
  }, [])

  const armCooldown = () => {
    setOnCooldown(true)
    if (cooldownTimerRef.current !== null) {
      clearTimeout(cooldownTimerRef.current)
    }
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null
      setOnCooldown(false)
    }, SOUNDBOARD_COOLDOWN_MS)
  }

  const playCustomClip = (clip: CustomSoundboardClip) => {
    if (listenOnly || deafened || localMuted || onCooldown) return
    if (clip.senderId !== undefined && mutedUserIds?.has(clip.senderId)) return
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined
    customCtxRef.current ??=
      audioContextFactory !== undefined
        ? audioContextFactory()
        : typeof Ctor === 'function'
          ? new Ctor()
          : null
    const ctx = customCtxRef.current
    if (ctx === null) return
    try {
      const gain = ctx.createGain()
      const samples = clip.buffer.numberOfChannels > 0 ? clip.buffer.getChannelData(0) : new Float32Array(0)
      gain.gain.value = computeLufsNormalizationGain(samples, SOUNDBOARD_TARGET_LUFS)
      gain.connect(ctx.destination)
      const source = ctx.createBufferSource()
      source.buffer = clip.buffer
      source.connect(gain)
      source.start()
      armCooldown()
      setOpen(false)
    } catch {
      // Ignore Web Audio playback errors on unsupported devices.
    }
  }

  const canPlay = !listenOnly && !deafened
  const label = canPlay ? copy.triggerLabel : copy.disabledLabel

  if (!canPlay) {
    return (
      <Tooltip content={label} names>
        <button
          type="button"
          data-testid="audio-dock-soundboard-trigger"
          aria-label={label}
          disabled
          className={cx(
            'focus-offset flex h-10 min-h-10 w-10 min-w-10 shrink-0 cursor-not-allowed items-center justify-center rounded-md border-2 border-transparent bg-c-inverse-2 text-c-on-inverse-dim opacity-50',
            TOUCH_TARGET
          )}
        >
          <EspaceGlyph name="speaker" />
        </button>
      </Tooltip>
    )
  }

  return (
    <Popover
      label={copy.triggerLabel}
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="center"
      trigger={
        <button
          type="button"
          data-testid="audio-dock-soundboard-trigger"
          aria-label={copy.triggerLabel}
          className={cx(
            'focus-offset flex h-10 min-h-10 w-10 min-w-10 shrink-0 items-center justify-center rounded-md border-2 border-transparent transition-colors duration-fast focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
            TOUCH_TARGET,
            open
              ? 'bg-c-on-inverse text-c-inverse'
              : 'bg-c-inverse-2 text-c-on-inverse hover:border-c-on-inverse-dim'
          )}
        >
          <EspaceGlyph name="speaker" />
        </button>
      }
    >
      <div
        data-testid="audio-dock-soundboard-popover"
        className="flex w-[224px] flex-col gap-2 text-c-ink"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-c-ink-2">{copy.heading}</p>
          <button
            type="button"
            data-testid="soundboard-local-mute-toggle"
            aria-pressed={localMuted}
            onClick={() => setLocalMuted((prev) => !prev)}
            className="rounded-sm px-1 text-xs font-medium text-c-accent-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
          >
            {localMuted ? copy.muteSelfOn.trim() : copy.muteSelfOff}
          </button>
        </div>
        {onCooldown ? (
          <p
            role="status"
            data-testid="soundboard-cooldown-status"
            className="text-xs font-mono text-c-ink-3"
          >
            {copy.cooldownNotice}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-1">
          {SOUNDBOARD_CUES.map((cue) => {
            const cueLabel = locale === 'en' ? cue.en : cue.fr
            return (
              <button
                key={cue.id}
                type="button"
                data-testid={`soundboard-cue-${cue.id}`}
                disabled={onCooldown || localMuted}
                onClick={() => {
                  if (listenOnly || deafened || localMuted || onCooldown) return
                  engine.play(cue.trigger, {
                    activeVoiceCall: true,
                    ...(roomId ? { roomId } : {}),
                  })
                  armCooldown()
                  setOpen(false)
                }}
                className="flex min-h-8 items-center gap-2 rounded-md border border-c-border-soft bg-c-sunken px-2 py-1 text-left text-xs font-medium text-c-ink hover:bg-c-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring focus-visible:outline-hidden"
              >
                <EspaceGlyph name="speaker" className="h-3 w-3 shrink-0 text-c-accent-ink" />
                <span className="truncate">{cueLabel}</span>
              </button>
            )
          })}
          {customClips.map((clip) => {
            const senderMuted = clip.senderId !== undefined && Boolean(mutedUserIds?.has(clip.senderId))
            return (
              <button
                key={clip.id}
                type="button"
                data-testid={`soundboard-custom-${clip.id}`}
                disabled={onCooldown || localMuted || senderMuted}
                onClick={() => playCustomClip(clip)}
                className="flex min-h-8 items-center gap-2 rounded-md border border-c-border-soft bg-c-sunken px-2 py-1 text-left text-xs font-medium text-c-ink hover:bg-c-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring focus-visible:outline-hidden"
              >
                <EspaceGlyph name="speaker" className="h-3 w-3 shrink-0 text-c-accent-ink" />
                <span className="truncate">{clip.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </Popover>
  )
}

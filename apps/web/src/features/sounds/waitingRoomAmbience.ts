// Waiting-room ambience controller with smooth speech auto-ducking (`duckForSpeech(speaking)`)
// and deterministic Web Audio teardown on unmount. Kept independent of `SoundboardPopover.tsx`
// so `VoiceCallDock`'s lazy soundboard chunk stays deferred until opened.

export const WAITING_AMBIENCE_DUCK_GAIN = 0.18

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

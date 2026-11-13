// Joining the call again after its connection was lost (docs/specs/espace-video-and-screenshare.md,
// « Reconnecting »). LiveKit first resumes the connection on its own (the call says
// `reconnecting`); when that fails, the call ends with `connection-lost`, and this joins the same
// room again after a growing, jittered wait: about 1, 2, 4, 8 then 16 seconds, five tries, never
// more than 30 seconds apart. While the browser is offline it waits for the network instead of
// spending a try.
//
// Only a lost connection is retried. A member removed from the room, a room closed, the call
// taken by another tab or ended because the microphone would not turn off, a refusal: none of
// these is joined again unasked. Leaving, joining another room, or being connected again ends the
// wait. A retry carries the member's own mute and deafen, as any switch of room does (`call.ts`).
//
// It watches the call only while something reads it (`subscribe`): made during a render, it holds
// no subscription and no timer until a screen subscribes, and lets both go with its last reader.

import type { CallProblem, CallSnapshot } from './call'

export const REJOIN_ATTEMPTS = 5
export const REJOIN_BASE_MS = 1000
export const REJOIN_MAX_MS = 30_000

/** Problems a later try can clear: the connection, never a decision taken about the member. */
const TRANSIENT: ReadonlySet<CallProblem> = new Set(['connection-lost', 'network', 'unavailable'])

/** The wait before try `attempt` (0 for the first), jittered between half and all of it. */
export function rejoinDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(REJOIN_MAX_MS, REJOIN_BASE_MS * 2 ** attempt)
  const jitter = Math.min(1, Math.max(0, random()))
  return Math.round(ceiling * (0.5 + jitter / 2))
}

export type RejoinPhase =
  /** Nothing to do: in a call, out of one, or ended for a reason not retried. */
  | 'idle'
  /** A try is due once the wait is over. */
  | 'waiting'
  /** The browser is offline: the next try waits for the network. */
  | 'offline'
  /** A try is under way: the call is connecting. */
  | 'trying'
  /** Every try failed: the member joins again by hand, or leaves. */
  | 'gave-up'

export interface RejoinSnapshot {
  phase: RejoinPhase
  /** The try under way or next, from 1; 0 when idle. */
  attempt: number
  readonly attempts: number
}

export interface RejoinCall {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => CallSnapshot
  join: (roomId: string) => Promise<void>
}

export interface RejoinOptions {
  random?: () => number
  online?: () => boolean
  /** Calls `listener` when the browser is back online; returns how to stop. */
  onOnline?: (listener: () => void) => () => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

const IDLE: RejoinSnapshot = Object.freeze({ phase: 'idle', attempt: 0, attempts: REJOIN_ATTEMPTS })

export class Rejoiner {
  readonly #call: RejoinCall
  readonly #random: () => number
  readonly #online: () => boolean
  readonly #onOnline: (listener: () => void) => () => void
  readonly #setTimer: (run: () => void, ms: number) => unknown
  readonly #clearTimer: (timer: unknown) => void
  readonly #listeners = new Set<() => void>()
  #snapshot: RejoinSnapshot = IDLE
  /** The room tries are for; null when idle. */
  #roomId: string | null = null
  /** Tries made for `#roomId`. */
  #tries = 0
  /** Whether the call's current join is one of ours. */
  #ours = false
  #timer: unknown = null
  #stopWaitingOnline: (() => void) | null = null
  #unsubscribe: (() => void) | null = null

  constructor(call: RejoinCall, options: RejoinOptions = {}) {
    this.#call = call
    this.#random = options.random ?? Math.random
    this.#online = options.online ?? (() => globalThis.navigator?.onLine !== false)
    this.#onOnline =
      options.onOnline ??
      ((listener) => {
        globalThis.addEventListener('online', listener)
        return () => globalThis.removeEventListener('online', listener)
      })
    this.#setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.#clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (this.#unsubscribe === null) {
      this.#unsubscribe = this.#call.subscribe(this.#observe)
      this.#observe()
    }
    return () => {
      if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return
      this.#unsubscribe?.()
      this.#unsubscribe = null
      this.#reset()
    }
  }

  getSnapshot = (): RejoinSnapshot => this.#snapshot

  /** Tries at once, from the member's click: the wait, or the network, is not waited on. */
  retryNow = (): void => {
    if (this.#roomId === null) return
    const { phase } = this.#snapshot
    if (phase !== 'waiting' && phase !== 'offline' && phase !== 'gave-up') return
    if (phase === 'gave-up') this.#tries = 0
    this.#try()
  }

  /** Stops waiting; the call is left as it is. */
  cancel = (): void => this.#reset()

  readonly #observe = (): void => {
    const call = this.#call.getSnapshot()
    if (call.status === 'connected') {
      this.#reset()
      return
    }
    if (call.status === 'idle' || (this.#roomId !== null && call.roomId !== this.#roomId)) {
      // Left, or another room joined: nothing of the old one is tried again.
      this.#reset()
      if (call.status === 'idle') return
    }
    if (call.status === 'connecting' || call.status === 'reconnecting') {
      if (this.#ours && this.#roomId !== null) this.#set({ phase: 'trying', attempt: this.#tries })
      return
    }
    // Ended or failed.
    const lost = call.status === 'ended' && call.problem === 'connection-lost'
    const tryFailed =
      this.#ours &&
      call.status === 'failed' &&
      call.problem !== undefined &&
      TRANSIENT.has(call.problem)
    if (call.roomId === null || !(lost || tryFailed)) {
      // Ended or refused for a reason a try cannot clear: the member decides.
      this.#reset()
      return
    }
    if (this.#snapshot.phase === 'waiting' || this.#snapshot.phase === 'offline') return
    this.#ours = false
    if (this.#roomId !== call.roomId) {
      this.#roomId = call.roomId
      this.#tries = 0
    }
    this.#schedule()
  }

  #schedule(): void {
    this.#cancelWait()
    if (this.#tries >= REJOIN_ATTEMPTS) {
      this.#set({ phase: 'gave-up', attempt: this.#tries })
      return
    }
    if (!this.#online()) {
      this.#set({ phase: 'offline', attempt: this.#tries + 1 })
      this.#stopWaitingOnline = this.#onOnline(() => this.#try())
      return
    }
    this.#set({ phase: 'waiting', attempt: this.#tries + 1 })
    this.#timer = this.#setTimer(
      () => {
        this.#timer = null
        this.#try()
      },
      rejoinDelay(this.#tries, this.#random)
    )
  }

  #try(): void {
    const roomId = this.#roomId
    if (roomId === null) return
    this.#cancelWait()
    this.#tries++
    this.#ours = true
    this.#set({ phase: 'trying', attempt: this.#tries })
    void this.#call.join(roomId).catch(() => {
      // The call's own snapshot says how the try went; the next one is scheduled from it.
    })
  }

  #cancelWait(): void {
    if (this.#timer !== null) this.#clearTimer(this.#timer)
    this.#timer = null
    this.#stopWaitingOnline?.()
    this.#stopWaitingOnline = null
  }

  #reset(): void {
    this.#cancelWait()
    this.#roomId = null
    this.#tries = 0
    this.#ours = false
    this.#set(IDLE)
  }

  #set(next: Omit<RejoinSnapshot, 'attempts'>): void {
    if (next.phase === this.#snapshot.phase && next.attempt === this.#snapshot.attempt) return
    this.#snapshot = Object.freeze({ ...next, attempts: REJOIN_ATTEMPTS })
    for (const listener of this.#listeners) listener()
  }
}

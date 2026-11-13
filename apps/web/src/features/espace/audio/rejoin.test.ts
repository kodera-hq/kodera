import { describe, expect, it, vi } from 'vitest'
import type { CallProblem, CallSnapshot, CallStatus } from './call'
import { REJOIN_ATTEMPTS, rejoinDelay, Rejoiner } from './rejoin'

const ROOM = '!standup:example.test'
const OTHER = '!retro:example.test'

function fakeCall() {
  let snapshot: CallSnapshot = {
    status: 'idle',
    roomId: null,
    muted: false,
    deafened: false,
    listenOnly: false,
    speakers: [],
    participants: [],
    playbackBlocked: false,
  }
  const listeners = new Set<() => void>()
  const set = (status: CallStatus, roomId: string | null = ROOM, problem?: CallProblem) => {
    snapshot = { ...snapshot, status, roomId, ...(problem === undefined ? {} : { problem }) }
    if (problem === undefined) delete snapshot.problem
    for (const listener of listeners) listener()
  }
  const join = vi.fn(async (roomId: string) => set('connecting', roomId))
  return {
    call: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      join,
    },
    set,
    join,
  }
}

function harness(online = true) {
  const fake = fakeCall()
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  let onlineListener: (() => void) | null = null
  let isOnline = online
  const rejoiner = new Rejoiner(fake.call, {
    random: () => 1,
    online: () => isOnline,
    onOnline: (listener) => {
      onlineListener = listener
      return () => (onlineListener = null)
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => ((timer as { cleared: boolean }).cleared = true),
  })
  // It watches the call only while read, as a screen reads it.
  const stop = rejoiner.subscribe(() => undefined)
  const fire = () => {
    const timer = timers.filter((t) => !t.cleared).at(-1)
    if (timer === undefined) throw new Error('no timer is waiting')
    timer.cleared = true
    timer.run()
  }
  return {
    ...fake,
    rejoiner,
    stop,
    timers,
    fire,
    goOnline: () => {
      isOnline = true
      onlineListener?.()
    },
    setOnline: (value: boolean) => (isOnline = value),
  }
}

describe('the wait before joining again', () => {
  it('doubles from one second, never past thirty, with jitter between half and all of it', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((attempt) => rejoinDelay(attempt, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
    expect(rejoinDelay(0, () => 0)).toBe(500)
    expect(rejoinDelay(3, () => 0.5)).toBe(6000)
    // A random source out of range is held to it.
    expect(rejoinDelay(0, () => 7)).toBe(1000)
    expect(rejoinDelay(0, () => -1)).toBe(500)
  })
})

describe('joining again after a lost connection', () => {
  it('joins the same room after the wait, and stops once connected', () => {
    const { set, rejoiner, fire, join, timers } = harness()
    set('connected')
    set('ended', ROOM, 'connection-lost')
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'waiting', attempt: 1 })
    expect(timers[0]!.ms).toBe(1000)
    fire()
    expect(join).toHaveBeenCalledWith(ROOM)
    expect(rejoiner.getSnapshot().phase).toBe('trying')
    set('connected')
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'idle', attempt: 0 })
  })

  it('backs off on each failed try, then gives up after five', () => {
    const { set, rejoiner, fire, join, timers } = harness()
    set('connected')
    set('ended', ROOM, 'connection-lost')
    for (let attempt = 1; attempt <= REJOIN_ATTEMPTS; attempt++) {
      expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'waiting', attempt })
      fire()
      set('failed', ROOM, 'network')
    }
    expect(join).toHaveBeenCalledTimes(REJOIN_ATTEMPTS)
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'gave-up', attempt: REJOIN_ATTEMPTS })
    // Given up, a try is the member's: « Réessayer » starts the count again.
    rejoiner.retryNow()
    expect(join).toHaveBeenCalledTimes(REJOIN_ATTEMPTS + 1)
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'trying', attempt: 1 })
  })

  it('never joins again a call ended or refused for a reason a try cannot clear', () => {
    const reasons: CallProblem[] = [
      'removed',
      'room-closed',
      'elsewhere',
      'microphone-stuck',
      'forbidden',
      'unauthenticated',
    ]
    for (const problem of reasons) {
      const { set, rejoiner, join, timers } = harness()
      set('connected')
      set(
        problem === 'forbidden' || problem === 'unauthenticated' ? 'failed' : 'ended',
        ROOM,
        problem
      )
      expect(rejoiner.getSnapshot().phase).toBe('idle')
      expect(timers).toHaveLength(0)
      expect(join).not.toHaveBeenCalled()
    }
  })

  it('stops trying when a try is refused outright', () => {
    const { set, rejoiner, fire, timers } = harness()
    set('connected')
    set('ended', ROOM, 'connection-lost')
    fire()
    set('failed', ROOM, 'forbidden')
    expect(rejoiner.getSnapshot().phase).toBe('idle')
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(0)
  })

  it('a join failing on its own, not one of ours, is not retried', () => {
    const { set, rejoiner, timers } = harness()
    set('connecting')
    set('failed', ROOM, 'network')
    expect(rejoiner.getSnapshot().phase).toBe('idle')
    expect(timers).toHaveLength(0)
  })

  it('waits for the network while offline, without spending a try', () => {
    const { set, rejoiner, goOnline, join, timers } = harness(false)
    set('connected')
    set('ended', ROOM, 'connection-lost')
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'offline', attempt: 1 })
    expect(timers).toHaveLength(0)
    goOnline()
    expect(join).toHaveBeenCalledWith(ROOM)
    expect(rejoiner.getSnapshot()).toMatchObject({ phase: 'trying', attempt: 1 })
  })

  it('stops waiting when the member leaves or joins another room', () => {
    const left = harness()
    left.set('connected')
    left.set('ended', ROOM, 'connection-lost')
    left.set('idle', null)
    expect(left.rejoiner.getSnapshot().phase).toBe('idle')
    expect(left.timers[0]!.cleared).toBe(true)

    const moved = harness()
    moved.set('connected')
    moved.set('ended', ROOM, 'connection-lost')
    moved.set('connecting', OTHER)
    expect(moved.rejoiner.getSnapshot().phase).toBe('idle')
    expect(moved.timers[0]!.cleared).toBe(true)
    expect(moved.join).not.toHaveBeenCalled()
  })

  it('tries at once from the member’s click, and not at all once cancelled or unread', () => {
    const { set, rejoiner, join, timers } = harness()
    set('connected')
    set('ended', ROOM, 'connection-lost')
    rejoiner.retryNow()
    expect(join).toHaveBeenCalledTimes(1)
    expect(timers[0]!.cleared).toBe(true)

    set('failed', ROOM, 'network')
    rejoiner.cancel()
    expect(rejoiner.getSnapshot().phase).toBe('idle')
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(0)
    rejoiner.retryNow()
    expect(join).toHaveBeenCalledTimes(1)

    const other = harness()
    other.set('connected')
    other.stop()
    other.set('ended', ROOM, 'connection-lost')
    expect(other.timers).toHaveLength(0)
  })

  it('watches nothing until read, and lets its wait go with its last reader', () => {
    const fake = fakeCall()
    const subscribe = vi.spyOn(fake.call, 'subscribe')
    const timers: { cleared: boolean }[] = []
    const rejoiner = new Rejoiner(fake.call, {
      setTimer: () => {
        const timer = { cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer) => ((timer as { cleared: boolean }).cleared = true),
      online: () => true,
    })
    expect(subscribe).not.toHaveBeenCalled()
    fake.set('connected')
    fake.set('ended', ROOM, 'connection-lost')
    const stop = rejoiner.subscribe(() => undefined)
    // Read late, it still sees the call as it is now.
    expect(rejoiner.getSnapshot().phase).toBe('waiting')
    stop()
    expect(timers[0]!.cleared).toBe(true)
    expect(rejoiner.getSnapshot().phase).toBe('idle')
  })
})

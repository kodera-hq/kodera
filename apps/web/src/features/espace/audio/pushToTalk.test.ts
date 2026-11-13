import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindPushToTalk, PUSH_TO_TALK_CODE, type PushToTalkCall } from './pushToTalk'
import type { CallSnapshot } from './call'

function call(patch: Partial<CallSnapshot> = {}) {
  let snapshot: CallSnapshot = {
    status: 'connected',
    roomId: '!standup:example.test',
    muted: false,
    deafened: false,
    listenOnly: false,
    speakers: [],
    participants: [],
    playbackBlocked: false,
    ...patch,
  }
  const setMuted = vi.fn(async (muted: boolean) => {
    snapshot = { ...snapshot, muted }
  })
  const fake: PushToTalkCall = { getSnapshot: () => snapshot, setMuted }
  return {
    fake,
    setMuted,
    set: (next: Partial<CallSnapshot>) => (snapshot = { ...snapshot, ...next }),
  }
}

function key(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit = {},
  target: EventTarget = window
) {
  const event = new KeyboardEvent(type, {
    code: PUSH_TO_TALK_CODE,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

let unbind: (() => void) | undefined
afterEach(() => {
  unbind?.()
  unbind = undefined
  document.body.replaceChildren()
})

describe('push-to-talk', () => {
  it('turns the microphone off when it starts, on while the key is held, and off at its release', () => {
    const { fake, setMuted } = call()
    unbind = bindPushToTalk(fake)
    expect(setMuted).toHaveBeenLastCalledWith(true)

    const down = key('keydown')
    expect(down.defaultPrevented).toBe(true)
    expect(setMuted).toHaveBeenLastCalledWith(false)
    // A key held repeats: nothing more is asked.
    key('keydown', { repeat: true })
    expect(setMuted).toHaveBeenCalledTimes(2)

    key('keyup')
    expect(setMuted).toHaveBeenLastCalledWith(true)
    expect(setMuted).toHaveBeenCalledTimes(3)
  })

  it('never turns the microphone on while typing, with a modifier, or for another key', () => {
    const { fake, setMuted } = call({ muted: true })
    unbind = bindPushToTalk(fake)
    const input = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(input, editable)

    key('keydown', {}, input)
    key('keydown', {}, editable)
    key('keydown', { ctrlKey: true })
    key('keydown', { metaKey: true })
    key('keydown', { altKey: true })
    key('keydown', { code: 'Space' })
    expect(setMuted).not.toHaveBeenCalled()
  })

  it('never undeafens, nor speaks in a listen-only room or outside a call that is through', () => {
    for (const patch of [
      { deafened: true, muted: true },
      { listenOnly: true, muted: true },
      { status: 'connecting' as const, muted: true },
      { status: 'reconnecting' as const, muted: true },
      { status: 'idle' as const, muted: true },
    ]) {
      const { fake, setMuted } = call(patch)
      const stop = bindPushToTalk(fake)
      key('keydown')
      expect(setMuted).not.toHaveBeenCalledWith(false)
      stop()
    }
  })

  it('lets go when the page loses the key: another window, a hidden tab, or the mode turned off', () => {
    for (const lose of [
      () => window.dispatchEvent(new Event('blur')),
      () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      },
      () => window.dispatchEvent(new Event('pagehide')),
    ]) {
      const { fake, setMuted } = call({ muted: true })
      const stop = bindPushToTalk(fake)
      key('keydown')
      expect(setMuted).toHaveBeenLastCalledWith(false)
      lose()
      expect(setMuted).toHaveBeenLastCalledWith(true)
      stop()
      vi.restoreAllMocks()
    }

    const { fake, setMuted } = call({ muted: true })
    const stop = bindPushToTalk(fake)
    key('keydown')
    stop()
    expect(setMuted).toHaveBeenLastCalledWith(true)
    // Once unbound, the key does nothing.
    key('keydown')
    expect(setMuted).toHaveBeenLastCalledWith(true)
  })

  it('releases even when the focus moved into a text field while the key was held', () => {
    const { fake, setMuted } = call({ muted: true })
    unbind = bindPushToTalk(fake)
    const input = document.createElement('input')
    document.body.append(input)
    key('keydown')
    key('keyup', {}, input)
    expect(setMuted).toHaveBeenLastCalledWith(true)
  })

  it('turning the mode off never turns the microphone on', () => {
    const { fake, setMuted } = call({ muted: true })
    const stop = bindPushToTalk(fake)
    stop()
    expect(setMuted).not.toHaveBeenCalledWith(false)
  })
})

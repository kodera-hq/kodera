import { expect, it, vi } from 'vitest'
import { createLocalAudioCall } from './audioCall'

it('simulates joining, mute, deafen and leave without media or network access', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const call = createLocalAudioCall('@member:demo.invalid')
  const listener = vi.fn()
  const unsubscribe = call.subscribe(listener)
  const idle = call.getSnapshot()
  expect(call.getSnapshot()).toBe(idle)
  await call.join('!office:demo.invalid')
  expect(call.mode).toBe('local-preview')
  expect(call.getSnapshot()).toMatchObject({
    status: 'connected',
    participants: ['@member:demo.invalid'],
    speakers: [],
  })
  await call.setMuted(true)
  expect(call.getSnapshot().muted).toBe(true)
  await call.setDeafened(true)
  expect(call.getSnapshot()).toMatchObject({ deafened: true, muted: true })
  await call.setDeafened(false)
  expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: true })
  await call.setMuted(false)
  await call.setDeafened(true)
  await call.setDeafened(false)
  expect(call.getSnapshot()).toMatchObject({ deafened: false, muted: false })
  await call.leave()
  expect(call.getSnapshot()).toEqual(idle)
  expect(fetch).not.toHaveBeenCalled()
  expect(listener).toHaveBeenCalled()
  unsubscribe()
  listener.mockClear()
  await call.join('!next:demo.invalid')
  expect(listener).not.toHaveBeenCalled()
  fetch.mockRestore()
})

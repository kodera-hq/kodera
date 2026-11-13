import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALL_PREFERENCES_STORAGE_KEY,
  DEFAULT_CALL_PREFERENCES,
  CallPreferences,
  readCallPreferences,
} from './callPreferences'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('call preferences', () => {
  it('start with voice activity and noise suppression on', () => {
    expect(readCallPreferences()).toEqual({ inputMode: 'voice', noiseSuppression: true })
    expect(DEFAULT_CALL_PREFERENCES).toEqual({ inputMode: 'voice', noiseSuppression: true })
  })

  it('keep a valid choice, and ignore anything else that was stored', () => {
    window.localStorage.setItem(
      CALL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ inputMode: 'push-to-talk', noiseSuppression: false })
    )
    expect(readCallPreferences()).toEqual({ inputMode: 'push-to-talk', noiseSuppression: false })

    for (const stored of [
      '{',
      'null',
      '"push-to-talk"',
      JSON.stringify({ inputMode: 'always-on', noiseSuppression: 'no' }),
      JSON.stringify({ inputMode: ['push-to-talk'] }),
    ]) {
      window.localStorage.setItem(CALL_PREFERENCES_STORAGE_KEY, stored)
      expect(readCallPreferences()).toEqual(DEFAULT_CALL_PREFERENCES)
    }
  })

  it('tell their readers of a change, and remember it', () => {
    const preferences = new CallPreferences()
    const listener = vi.fn()
    const stop = preferences.subscribe(listener)
    preferences.update({ inputMode: 'push-to-talk' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(preferences.getSnapshot()).toEqual({ inputMode: 'push-to-talk', noiseSuppression: true })
    expect(new CallPreferences().getSnapshot().inputMode).toBe('push-to-talk')
    // The same choice again draws nothing.
    preferences.update({ inputMode: 'push-to-talk' })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    preferences.update({ noiseSuppression: false })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('still change for this page when the browser refuses to store them', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const preferences = new CallPreferences()
    preferences.update({ noiseSuppression: false })
    expect(preferences.getSnapshot().noiseSuppression).toBe(false)
  })
})

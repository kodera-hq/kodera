import { afterEach, describe, expect, it, vi } from 'vitest'
import { onTrack, track } from './track'

describe('track', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hands each listener the event name and its properties', () => {
    const listener = vi.fn()
    const unsubscribe = onTrack(listener)

    track('home_viewed', { tenant_state: 'active', cards_rendered: 6 })

    expect(listener).toHaveBeenCalledWith({
      name: 'home_viewed',
      properties: { tenant_state: 'active', cards_rendered: 6 },
    })
    unsubscribe()
  })

  it('fans one event out to every listener', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = onTrack(first)
    const unsubscribeSecond = onTrack(second)

    track('status_history_opened', {})

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn()
    onTrack(listener)()

    track('login_discovery_submitted', { kind: 'email' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('lets a listener unsubscribe itself mid-dispatch without skipping the next one', () => {
    const second = vi.fn()
    const unsubscribeSecond = onTrack(second)
    const unsubscribeFirst = onTrack(() => {
      unsubscribeFirst()
    })

    expect(() => track('organisation_switched', { membership_count: 2 })).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
    unsubscribeSecond()
  })

  it('records nothing anywhere when no one is listening', () => {
    expect(() => track('mfa_enrolment_started', { method: 'totp' })).not.toThrow()
    expect(track('mfa_enrolment_started', { method: 'totp' })).toBeUndefined()
  })

  it('opens no network connection and writes to no storage', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const beaconSpy = vi.fn()
    vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon: beaconSpy })
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const localSet = vi.spyOn(Storage.prototype, 'setItem')

    const unsubscribe = onTrack(() => {})
    track('status_app_url_copied', { app: 'visio' })
    unsubscribe()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(beaconSpy).not.toHaveBeenCalled()
    expect(xhrOpen).not.toHaveBeenCalled()
    expect(localSet).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('keeps no queue of its own: a listener registered after an event never sees it', () => {
    track('home_app_opened', { app: 'visio' })

    const late = vi.fn()
    const unsubscribe = onTrack(late)

    expect(late).not.toHaveBeenCalled()
    unsubscribe()
  })
})

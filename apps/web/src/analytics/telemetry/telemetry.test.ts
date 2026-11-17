import type { AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track, type AnalyticsEvent } from '../track'
import { startTelemetry } from './bootstrap'
import {
  bindTelemetryScope,
  getTelemetryScope,
  hasTelemetryConsent,
  refreshTelemetryConsent,
  setTelemetryConsent,
  setTelemetryScope,
} from './consent'
import { measureTelemetryOperation, reportTelemetryError } from './diagnostics'
import { CAPTURE_PRIVACY, codeStack, EU_INGESTION_HOST, sanitizeTelemetryEvent } from './privacy'
import { createTelemetryTransport } from './transport'

const scope = { person: 'person-a', workspace: 'workspace-a', slug: 'sample' }
const disposals: (() => void)[] = []
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function mockRouter() {
  const callbacks = new Map<string, (event: { toLocation: { pathname: string } }) => void>()
  const router = {
    subscribe: vi.fn(
      (name: string, callback: (event: { toLocation: { pathname: string } }) => void) => {
        callbacks.set(name, callback)
        return () => callbacks.delete(name)
      }
    ),
  } as unknown as AnyRouter
  return { router, callbacks }
}
beforeEach(() => {
  localStorage.clear()
  setTelemetryScope(scope)
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  setTelemetryScope(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('privacy construction', () => {
  it('discards unknown events, dynamic properties, tokens, email, text and file names', () => {
    expect(
      sanitizeTelemetryEvent({
        name: 'private-message',
        properties: { email: 'member@example.test' },
      })
    ).toBeUndefined()
    expect(
      sanitizeTelemetryEvent({
        name: 'operation_completed',
        properties: {
          operation: 'docs_save',
          duration_ms: 12,
          success: true,
          email: 'member@example.test',
          token: 'bearer-private',
          content: 'private message',
          filename: 'private.doc',
          key: 'encryption-secret',
          yjs: 'binary-update',
        },
      })
    ).toEqual({
      name: 'operation_completed',
      properties: { operation: 'docs_save', duration_ms: 12, success: true },
    })
    expect(
      sanitizeTelemetryEvent({
        name: 'client_error',
        properties: {
          kind: 'private message',
          area: 'member@example.test',
          stack: 'assets/private-message.js:1:1\nbundle:12:34\nprivate-token',
          message: 'private message',
        },
      })
    ).toEqual({ name: 'client_error', properties: { stack: 'bundle:12:34' } })
  })
  it('contains hostile error name/stack getters without interrupting a boundary', () => {
    const error = new Error('private')
    Object.defineProperty(error, 'name', {
      get() {
        throw new Error('private')
      },
    })
    expect(() => reportTelemetryError(error, 'boundary', 'RouteError')).not.toThrow()
    const stack = new Error('private')
    Object.defineProperty(stack, 'stack', {
      get() {
        throw new Error('private')
      },
    })
    expect(() => reportTelemetryError(stack, 'rejection')).not.toThrow()
  })
  it('bounds numbers and refuses non-finite values and prototype event names', () => {
    expect(
      sanitizeTelemetryEvent({
        name: 'operation_completed',
        properties: { duration_ms: Infinity, success: false },
      })?.properties
    ).toEqual({ success: false })
    expect(
      sanitizeTelemetryEvent({
        name: 'organisation_switched',
        properties: { membership_count: 9e99 },
      })?.properties.membership_count
    ).toBe(3_600_000)
    expect(sanitizeTelemetryEvent({ name: 'constructor', properties: {} })).toBeUndefined()
  })
  it('keeps static code positions only from same-origin bundled locations', () => {
    const error = new TypeError('member@example.test private message token')
    error.stack =
      'TypeError: member@example.test\n at secretFunction (https://console.test/assets/private-name.js:12:34)\n at https://external.test/assets/other.js:1:2\n at https://console.test/assets/name.js?token=secret:1:2'
    expect(codeStack(error, 'https://console.test')).toBe('bundle:12:34')
    expect(CAPTURE_PRIVACY).toEqual({
      maskAllInputs: true,
      blockSelector: '[data-ph-no-capture], .ph-no-capture',
      autocapture: false,
      sessionRecording: false,
    })
  })
})

describe('transport', () => {
  it.each([
    'https://us.i.posthog.com',
    'http://eu.i.posthog.com',
    'https://eu.i.posthog.com/',
    'https://eu.i.posthog.com.evil.test',
    'https://eu.i.posthog.com:443',
    'https://user@eu.i.posthog.com',
  ])('refuses host %s before network', (host) => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(createTelemetryTransport('public-project-key', host)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
  it('sends allowlisted anonymous data without cookies, referrer, URL enrichment or redirects', async () => {
    const request = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', request)
    const transport = createTelemetryTransport('public-project-key', EU_INGESTION_HOST)!
    transport.capture({
      name: 'channel_joined',
      properties: {
        kind: 'chat',
        room_id: '!private:server',
        email: 'person@example.test',
        message: 'secret',
      },
    })
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(init).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
    })
    const body = JSON.parse(init.body)
    expect(body.distinct_id).toEqual(expect.any(String))
    expect(body.properties).toEqual({
      kind: 'chat',
      $process_person_profile: false,
      $geoip_disable: true,
    })
    expect(JSON.stringify(body)).not.toMatch(/private|person@|secret/)
    transport.stop()
    await settle()
  })
  it('wipes session, aborts pending requests and sends nothing after stop', () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', request)
    const transport = createTelemetryTransport('public-project-key', EU_INGESTION_HOST)!
    const event = { name: 'channel_joined', properties: { kind: 'chat' } }
    transport.capture(event)
    const signal = request.mock.calls[0]![1].signal as AbortSignal
    transport.stop()
    transport.capture(event)
    expect(signal.aborted).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })
  it('bounds event delivery per minute without queuing excess activity', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const request = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', request)
    const transport = createTelemetryTransport('key', EU_INGESTION_HOST)!
    for (let index = 0; index < 100; index++)
      transport.capture({ name: 'channel_joined', properties: { kind: 'chat' } })
    expect(request).toHaveBeenCalledTimes(60)
    clock.mockReturnValue(60_001)
    transport.capture({ name: 'channel_joined', properties: { kind: 'chat' } })
    expect(request).toHaveBeenCalledTimes(61)
    transport.stop()
  })
  it('isolates malformed payload getters and synchronous network failures', () => {
    const request = vi.fn(() => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', request)
    const transport = createTelemetryTransport('public-project-key', EU_INGESTION_HOST)!
    const hostile = {
      name: 'channel_joined',
      get properties() {
        throw new Error('private')
      },
    } as unknown as AnalyticsEvent
    expect(() => transport.capture(hostile)).not.toThrow()
    expect(() =>
      transport.capture({ name: 'channel_joined', properties: { kind: 'chat' } })
    ).not.toThrow()
    transport.stop()
  })
})

describe('scoped consent and startup', () => {
  it.each([
    ['', EU_INGESTION_HOST],
    ['key', 'https://us.i.posthog.com'],
    ['key', EU_INGESTION_HOST],
  ])(
    'does not import the transport or use network while disabled or opted out (%s, %s)',
    async (key, host) => {
      const load = vi.fn()
      const request = vi.fn()
      vi.stubGlobal('fetch', request)
      disposals.push(await startTelemetry(mockRouter().router, key!, host!, load))
      track('channel_joined', { kind: 'chat' })
      expect(load).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('starts only after consent, never backfills, and immediately aborts on withdrawal', async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', request)
    const load = vi.fn(async () => ({ createTelemetryTransport }))
    disposals.push(await startTelemetry(mockRouter().router, 'key', EU_INGESTION_HOST, load))
    track('channel_joined', { kind: 'chat' })
    expect(load).not.toHaveBeenCalled()
    setTelemetryConsent(true)
    await settle()
    expect(request).not.toHaveBeenCalled()
    track('channel_joined', { kind: 'chat' })
    expect(request).toHaveBeenCalledOnce()
    const signal = request.mock.calls[0]![1].signal as AbortSignal
    setTelemetryConsent(false)
    expect(signal.aborted).toBe(true)
    expect(hasTelemetryConsent()).toBe(false)
    track('channel_joined', { kind: 'chat' })
    expect(request).toHaveBeenCalledOnce()
  })
  it('refuses stale lazy imports after consent changes', async () => {
    let finish:
      ((value: { createTelemetryTransport: typeof createTelemetryTransport }) => void) | undefined
    const create = vi.fn(createTelemetryTransport)
    setTelemetryConsent(true)
    disposals.push(
      await startTelemetry(
        mockRouter().router,
        'key',
        EU_INGESTION_HOST,
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    )
    setTelemetryConsent(false)
    finish!({ createTelemetryTransport: create })
    await settle()
    expect(create).not.toHaveBeenCalled()
  })
  it('does not transfer consent between accounts/workspaces and ignores old cleanup', () => {
    const clearOld = setTelemetryScope(scope)
    setTelemetryConsent(true)
    setTelemetryScope({ ...scope, workspace: 'workspace-b' })
    clearOld()
    expect(getTelemetryScope()?.workspace).toBe('workspace-b')
    expect(hasTelemetryConsent()).toBe(false)
    setTelemetryScope({ ...scope, person: 'person-b' })
    expect(hasTelemetryConsent()).toBe(false)
  })
  it('fails closed when storage writes or removals fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setTelemetryConsent(true)
    expect(hasTelemetryConsent()).toBe(false)
    vi.restoreAllMocks()
    setTelemetryConsent(true)
    expect(hasTelemetryConsent()).toBe(true)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setTelemetryConsent(false)
    expect(hasTelemetryConsent()).toBe(false)
    setTelemetryScope({ ...scope, workspace: 'another' })
    setTelemetryScope(scope)
    expect(hasTelemetryConsent()).toBe(false)
  })
  it('observes cross-tab withdrawal and ignores unrelated workspace storage', () => {
    setTelemetryConsent(true)
    refreshTelemetryConsent(new StorageEvent('storage', { key: 'unrelated', newValue: null }))
    expect(hasTelemetryConsent()).toBe(true)
    refreshTelemetryConsent(new StorageEvent('storage', { key: null }))
    expect(hasTelemetryConsent()).toBe(false)
  })
  it('retires synchronously when the authentication lifetime stamp changes', () => {
    let listener = () => {}
    let stamp = {}
    let usable = true
    const clear = bindTelemetryScope(scope, {
      hasUsableCredential: () => usable,
      getRetirementStamp: () => stamp,
      subscribe: (callback) => {
        listener = callback
        return () => {}
      },
    })
    setTelemetryConsent(true)
    stamp = {}
    listener()
    expect(getTelemetryScope()).toBeUndefined()
    expect(hasTelemetryConsent()).toBe(false)
    clear()
    usable = false
    bindTelemetryScope(scope, {
      hasUsableCredential: () => usable,
      getRetirementStamp: () => stamp,
      subscribe: () => () => {},
    })
    expect(getTelemetryScope()).toBeUndefined()
  })
  it('collects only fixed performance metrics and never retains resource URLs or content', async () => {
    const callbacks = new Map<string, PerformanceObserverCallback>()
    const disconnected = vi.fn()
    const observations: PerformanceObserverInit[] = []
    class Observer {
      static supportedEntryTypes = ['largest-contentful-paint', 'layout-shift', 'event', 'resource']
      constructor(private callback: PerformanceObserverCallback) {}
      observe(options: PerformanceObserverInit) {
        observations.push(options)
        callbacks.set(options.type!, this.callback)
      }
      disconnect = disconnected
    }
    vi.stubGlobal('PerformanceObserver', Observer)
    const request = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', request)
    setTelemetryConsent(true)
    disposals.push(
      await startTelemetry(mockRouter().router, 'key', EU_INGESTION_HOST, async () => ({
        createTelemetryTransport,
      }))
    )
    await settle()
    function emit(type: string, entries: object[]) {
      callbacks.get(type)!(
        { getEntries: () => entries } as PerformanceObserverEntryList,
        {} as PerformanceObserver
      )
    }
    emit('largest-contentful-paint', [{ startTime: 120 }])
    emit('layout-shift', [
      { startTime: 100, value: 0.2 },
      { startTime: 200, value: 0.3 },
      { startTime: 1500, value: 0.4 },
    ])
    emit('event', [{ interactionId: 1, duration: 32 }])
    emit('resource', [
      {
        name: 'https://matrix.test/_matrix/client/v3/rooms/private-id/send/m.room.message/private-token?email=member@example.test',
        duration: 42,
      },
    ])
    const bodies = request.mock.calls.map((call) => JSON.parse(call[1].body))
    expect(bodies.map((body) => body.properties.metric).filter(Boolean)).toEqual([
      'LCP',
      'CLS',
      'CLS',
      'CLS',
      'interaction_latency',
    ])
    expect(bodies[3].properties.value).toBe(0.5)
    expect(bodies[5].properties).toMatchObject({ operation: 'chat_send', duration_ms: 42 })
    expect(bodies[5].properties).not.toHaveProperty('success')
    expect(JSON.stringify(bodies)).not.toMatch(/private|member@|matrix.test/)
    expect(observations.every((options) => options.buffered === false)).toBe(true)
    const stale = callbacks.get('resource')!
    setTelemetryConsent(false)
    expect(disconnected).toHaveBeenCalledTimes(4)
    setTelemetryConsent(true)
    await settle()
    stale(
      { getEntries: () => [{ name: 'https://matrix.test/_matrix/media/v3/upload', duration: 10 }] } as unknown as PerformanceObserverEntryList,
      {} as PerformanceObserver
    )
    expect(request).toHaveBeenCalledTimes(6)
  })
  it('does not deliver an operation that began before consent or survived withdrawal', async () => {
    const request = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', request)
    disposals.push(
      await startTelemetry(mockRouter().router, 'key', EU_INGESTION_HOST, async () => ({
        createTelemetryTransport,
      }))
    )
    let complete = () => {}
    const before = measureTelemetryOperation(
      'docs_load',
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    setTelemetryConsent(true)
    await settle()
    complete()
    await before
    expect(request).not.toHaveBeenCalled()
    const during = measureTelemetryOperation(
      'docs_save',
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    setTelemetryConsent(false)
    setTelemetryConsent(true)
    await settle()
    complete()
    await during
    expect(request).not.toHaveBeenCalled()
  })
  it('retires before navigating to another workspace', async () => {
    setTelemetryConsent(true)
    const { router, callbacks } = mockRouter()
    disposals.push(
      await startTelemetry(
        router,
        'key',
        EU_INGESTION_HOST,
        vi.fn(async () => ({ createTelemetryTransport }))
      )
    )
    callbacks.get('onBeforeNavigate')!({ toLocation: { pathname: '/another/workspace' } })
    expect(hasTelemetryConsent()).toBe(false)
    expect(getTelemetryScope()).toBeUndefined()
  })
  it('reports real operation failure and drops private rejection details', async () => {
    const request = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', request)
    setTelemetryConsent(true)
    disposals.push(
      await startTelemetry(
        mockRouter().router,
        'key',
        EU_INGESTION_HOST,
        vi.fn(async () => ({ createTelemetryTransport }))
      )
    )
    await settle()
    await expect(
      measureTelemetryOperation('docs_save', async () => {
        throw new Error('private document')
      })
    ).rejects.toThrow('private document')
    reportTelemetryError(
      new TypeError('private message person@example.test bearer token'),
      'rejection'
    )
    const bodies = request.mock.calls.map((call) => JSON.parse(call[1].body))
    expect(bodies[0].properties).toMatchObject({ operation: 'docs_save', success: false })
    expect(bodies[1].properties).toMatchObject({ kind: 'TypeError', source: 'rejection' })
    expect(JSON.stringify(bodies)).not.toMatch(/private|person@|bearer/)
  })
})

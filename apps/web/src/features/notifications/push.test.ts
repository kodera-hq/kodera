import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applicationServerKey,
  disablePush,
  PUSH_COPY_CACHE,
  PUSH_DEVICE_KEY,
  PushRefused,
  subscriptionKeys,
} from './push'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  Reflect.deleteProperty(window.navigator, 'serviceWorker')
})

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
}

const point = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65))
  bytes[0] = 4
  return bytes
}

describe('Web Push keys', () => {
  it('reads Core’s VAPID key as an uncompressed P-256 point', () => {
    const key = point()
    expect(applicationServerKey(base64url(key))).toEqual(key)
  })

  it('refuses a key of another shape', () => {
    const wrong = point()
    wrong[0] = 2
    for (const bad of [base64url(wrong), 'short', `${base64url(point())}!`]) {
      expect(() => applicationServerKey(bad)).toThrow(PushRefused)
    }
  })

  it('files only an https endpoint with keys of the contract’s sizes', () => {
    const p256dh = base64url(point())
    const auth = base64url(crypto.getRandomValues(new Uint8Array(16)))
    expect(p256dh).toHaveLength(87)
    expect(auth).toHaveLength(22)
    const endpoint = 'https://push.exemple.fr/send/abc'
    expect(subscriptionKeys({ endpoint, keys: { p256dh, auth } })).toEqual({
      endpoint,
      p256dh,
      auth,
    })
    for (const bad of [
      { endpoint: 'http://push.exemple.fr/x', keys: { p256dh, auth } },
      { endpoint: 'https://u:p@push.exemple.fr/x', keys: { p256dh, auth } },
      { endpoint: 'javascript:alert(1)', keys: { p256dh, auth } },
      { endpoint, keys: { p256dh: 'x', auth } },
      { endpoint, keys: { p256dh, auth: `${auth}=` } },
      { endpoint },
    ]) {
      expect(() => subscriptionKeys(bad)).toThrow(PushRefused)
    }
  })
})

describe('the push worker', () => {
  it('never reads a push payload', async () => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const source = await readFile(resolve(process.cwd(), 'public/push-sw.js'), 'utf8')
    // The one `.data` read is the page's message to the worker; a push's is never touched.
    expect(source.match(/\b\w+\.data\b/gu)).toEqual(['message.data'])
    expect(source).not.toMatch(/push\.data/u)
    expect(source).not.toMatch(/\bfetch\(/u)
    expect(source).not.toMatch(/importScripts/u)
  })
})

describe('disablePush teardown', () => {
  it('deletes the server subscription before clearing PUSH_DEVICE_KEY, unsubscribes PushManager, and removes the copy cache', async () => {
    import.meta.env['VITE_CORE_API_URL'] = 'https://core.example.test/api/v1'
    const deviceUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    localStorage.setItem(PUSH_DEVICE_KEY, deviceUuid)

    const order: string[] = []
    const unsubscribe = vi.fn(async () => {
      order.push('unsubscribe')
      return true
    })
    const postMessage = vi.fn()
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe })) },
          active: { postMessage },
        })),
      },
    })
    const deleteCache = vi.fn(async (name: string) => {
      order.push(`cache:${name}`)
      return true
    })
    vi.stubGlobal('caches', { delete: deleteCache })

    let keyAtDelete: string | null = null
    let authAtDelete: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const req = input as Request
        order.push(`delete:${new URL(req.url).pathname}`)
        keyAtDelete = localStorage.getItem(PUSH_DEVICE_KEY)
        authAtDelete = req.headers.get('Authorization')
        return new Response(null, { status: 204 })
      })
    )

    const originalRemoveItem = Storage.prototype.removeItem
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      if (key === PUSH_DEVICE_KEY) order.push('remove-key')
      originalRemoveItem.call(this, key)
    })

    try {
      await disablePush({ accessToken: 'outgoing-token' })
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(deleteCache).toHaveBeenCalledWith(PUSH_COPY_CACHE)
      expect(postMessage).toHaveBeenCalledWith({ type: 'kodera-push-forget' })
      expect(keyAtDelete).toBe(deviceUuid)
      expect(authAtDelete).toBe('Bearer outgoing-token')
      expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBeNull()
      expect(order).toEqual([
        `delete:/api/v1/push/subscriptions/${deviceUuid}`,
        'unsubscribe',
        `cache:${PUSH_COPY_CACHE}`,
        'remove-key',
      ])
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('bounds a stalled DELETE request during best-effort teardown and still unsubscribes and removes PUSH_DEVICE_KEY', async () => {
    import.meta.env['VITE_CORE_API_URL'] = 'https://core-stalled-push.example.test/api/v1'
    const deviceUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    localStorage.setItem(PUSH_DEVICE_KEY, deviceUuid)

    const order: string[] = []
    const unsubscribe = vi.fn(async () => {
      order.push('unsubscribe')
      return true
    })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe })) },
          active: { postMessage: vi.fn() },
        })),
      },
    })
    const deleteCache = vi.fn(async (name: string) => {
      order.push(`cache:${name}`)
      return true
    })
    vi.stubGlobal('caches', { delete: deleteCache })

    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        order.push('delete-started')
        return new Promise<Response>(() => {})
      })
    )

    const originalRemoveItem = Storage.prototype.removeItem
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      if (key === PUSH_DEVICE_KEY) order.push('remove-key')
      originalRemoveItem.call(this, key)
    })

    try {
      await disablePush({ accessToken: 'outgoing-token', bestEffort: true, timeoutMs: 25 })
      expect(order).toEqual([
        'delete-started',
        'unsubscribe',
        `cache:${PUSH_COPY_CACHE}`,
        'remove-key',
      ])
      expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBeNull()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('still unsubscribes an active browser PushSubscription and removes the copy cache when PUSH_DEVICE_KEY is absent', async () => {
    const unsubscribe = vi.fn(async () => true)
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe })) },
          active: { postMessage: vi.fn() },
        })),
      },
    })
    const deleteCache = vi.fn(async () => true)
    vi.stubGlobal('caches', { delete: deleteCache })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await disablePush({ bestEffort: true })

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(deleteCache).toHaveBeenCalledWith(PUSH_COPY_CACHE)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

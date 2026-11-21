import { createElement } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthSessionSnapshot, AuthUser } from './AuthAdapter'
import { AuthProvider, useAuth } from './AuthProvider'
import {
  clearLocalSessionStorage,
  DOCS_COLLAB_DATABASE,
  DOCS_COLLAB_DATABASE_PREFIX,
  DOCS_COLLAB_REGISTRY_KEY,
  ESPACE_TIMELINE_DATABASE,
  PUSH_COPY_CACHE,
  registerLocalSessionCleanup,
} from './localSession'
import { mutedChannelsStorageKey } from '../features/espace/EspaceLiveView'
import { UnfurlCache, unfurlCache } from '../features/messaging/unfurl/unfurlCache'
import { defaultNotificationFeed } from '../features/notifications/NotificationCenter'
import { NotificationFeed } from '../features/notifications/notificationFeed'
import { PUSH_DEVICE_KEY } from '../features/notifications/push'
import { getLocalProfile, updateLocalProfile } from '../features/profile/localProfile'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('the local sign-out', () => {
  it("deletes Espace's device cache of messages, whether or not Espace was opened", () => {
    const deleteDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase })
    clearLocalSessionStorage()
    expect(deleteDatabase).toHaveBeenCalledWith(ESPACE_TIMELINE_DATABASE)
    expect(deleteDatabase).toHaveBeenCalledWith(DOCS_COLLAB_DATABASE)
  })

  it('wipes all registered collaborative document Yjs IndexedDB databases and invokes teardown hooks', () => {
    const order: string[] = []
    const deleteDatabase = vi.fn((name: string) => {
      order.push(`delete:${name}`)
    })
    const databases = vi.fn(async () => [
      { name: `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-orphan` },
      { name: 'unrelated-third-party-db' },
    ])
    vi.stubGlobal('indexedDB', { deleteDatabase, databases })

    window.localStorage.setItem(
      DOCS_COLLAB_REGISTRY_KEY,
      JSON.stringify([
        `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-alpha`,
        `${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-beta`,
        'unrelated-db-ignored',
      ])
    )

    const disposeHandle = vi.fn(() => {
      order.push('close-handle')
    })
    const unregister = registerLocalSessionCleanup(disposeHandle)

    clearLocalSessionStorage()
    unregister()

    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(order[0]).toBe('close-handle')
    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-alpha`)
    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-1:doc-beta`)
    expect(deleteDatabase).not.toHaveBeenCalledWith('unrelated-db-ignored')
    expect(window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)).toBeNull()
  })

  it('sweeps enumerated Yjs IndexedDB databases not present in localStorage registry', async () => {
    const deleteDatabase = vi.fn()
    const databases = vi.fn(async () => [
      { name: `${DOCS_COLLAB_DATABASE_PREFIX}org-2:doc-99` },
      { name: 'other-origin-store' },
    ])
    vi.stubGlobal('indexedDB', { deleteDatabase, databases })

    clearLocalSessionStorage()
    await Promise.resolve()

    expect(deleteDatabase).toHaveBeenCalledWith(`${DOCS_COLLAB_DATABASE_PREFIX}org-2:doc-99`)
    expect(deleteDatabase).not.toHaveBeenCalledWith('other-origin-store')
  })

  it('still clears the browser storage where IndexedDB refuses', () => {
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        throw new DOMException('refused', 'SecurityError')
      },
    })
    window.localStorage.setItem('kodera.web.test', 'value')
    clearLocalSessionStorage()
    expect(window.localStorage.getItem('kodera.web.test')).toBeNull()
  })
})

it('clears saved composer text and remembered channels even without an open workspace', () => {
  sessionStorage.setItem('kodera:drafts:organisation:person', 'unsent text')
  localStorage.setItem('kodera:last-channel:organisation:person', 'general')
  localStorage.setItem('console:theme', 'dark')
  clearLocalSessionStorage()
  expect(sessionStorage.getItem('kodera:drafts:organisation:person')).toBeNull()
  expect(localStorage.getItem('kodera:last-channel:organisation:person')).toBeNull()
  expect(localStorage.getItem('console:theme')).toBe('dark')
})

it('scrubs profile and user-namespaced muted-channel keys, resets module singletons, and keeps cleanup listeners across consecutive sign-outs', async () => {
  const aliceId = '@alice-uuid:acme.kodera.test'
  const bobId = '@bob-uuid:acme.kodera.test'
  const aliceMuteKey = mutedChannelsStorageKey('acme', 'org-uuid-1', aliceId)
  const bobMuteKey = mutedChannelsStorageKey('acme', 'org-uuid-1', bobId)
  expect(aliceMuteKey).toBe(`kodera.muted-channels.acme:org-uuid-1:${aliceId}`)
  expect(aliceMuteKey).not.toBe(bobMuteKey)

  localStorage.setItem(aliceMuteKey, JSON.stringify(['chan-1']))
  localStorage.setItem('kodera.muted-channels.legacy:org-uuid-1', JSON.stringify(['chan-2']))
  updateLocalProfile(aliceId, { displayName: 'Alice', presence: 'dnd', status: 'In call' })
  expect(getLocalProfile(aliceId).displayName).toBe('Alice')

  const moduleCalls = vi.fn()
  const unsubscribe = registerLocalSessionCleanup(moduleCalls)
  try {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    import.meta.env['VITE_CORE_API_URL'] = 'https://core.example.test/api/v1'

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'notif-1',
              resourceId: 'res-1',
              kind: 'mention',
              createdAt: '2026-01-01T10:00:00Z',
              readAt: null,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    await defaultNotificationFeed.refresh()
    expect(defaultNotificationFeed.getSnapshot().items).toHaveLength(1)
    expect(defaultNotificationFeed.getSnapshot().unread).toBe(1)

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://kodera.io/spec',
          site: 'kodera.io',
          title: 'Private Spec',
          description: 'Confidential summary',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    unfurlCache.request('org-1', 'https://kodera.io/spec')
    await vi.waitFor(() =>
      expect(unfurlCache.card('org-1', 'https://kodera.io/spec')?.title).toBe('Private Spec')
    )

    // First sign-out wipes storage and in-memory singletons.
    clearLocalSessionStorage()
    expect(moduleCalls).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`kodera.profile.${aliceId}`)).toBeNull()
    expect(localStorage.getItem(aliceMuteKey)).toBeNull()
    expect(localStorage.getItem('kodera.muted-channels.legacy:org-uuid-1')).toBeNull()
    expect(getLocalProfile(aliceId)).toEqual({ displayName: '', presence: 'online', status: '' })
    expect(defaultNotificationFeed.getSnapshot()).toEqual({
      status: 'loading',
      items: [],
      unread: 0,
    })
    expect(unfurlCache.card('org-1', 'https://kodera.io/spec')).toBeUndefined()

    // Even if User B's subsequent /notifications fetch fails, User A's items never reappear.
    fetchSpy.mockRejectedValueOnce(new Error('offline'))
    await defaultNotificationFeed.refresh()
    expect(defaultNotificationFeed.getSnapshot()).toEqual({
      status: 'unavailable',
      items: [],
      unread: 0,
    })

    // Second consecutive sign-out still invokes module-level cleanup listeners (including fallback memory).
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    })
    updateLocalProfile(bobId, { displayName: 'Bob Fallback', presence: 'focused', status: 'Busy' })
    expect(getLocalProfile(bobId).displayName).toBe('Bob Fallback')
    setItemSpy.mockRestore()

    clearLocalSessionStorage()
    expect(moduleCalls).toHaveBeenCalledTimes(2)
    expect(getLocalProfile(bobId)).toEqual({ displayName: '', presence: 'online', status: '' })
  } finally {
    unsubscribe()
  }
})

it('unsubscribes pushManager, deletes the server push subscription before clearing PUSH_DEVICE_KEY, and deletes the push copy cache before clearing token and session on signOut', async () => {
  import.meta.env['VITE_CORE_API_URL'] = 'https://core-push-signout.example.test/api/v1'
  const deviceUuid = '11111111-2222-4333-8444-555555555555'
  localStorage.setItem(PUSH_DEVICE_KEY, deviceUuid)
  sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home')

  const events: string[] = []
  const unsubscribePush = vi.fn(async () => {
    events.push('unsubscribe')
    return true
  })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', { permission: 'granted' })
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => ({
        pushManager: {
          getSubscription: vi.fn(async () => ({ unsubscribe: unsubscribePush })),
        },
        active: { postMessage: vi.fn() },
      })),
    },
  })
  const deleteCache = vi.fn(async (name: string) => {
    events.push(`cache-delete:${name}`)
    return true
  })
  vi.stubGlobal('caches', { delete: deleteCache })

  let observedAuthHeader: string | null = null
  let keyDuringDelete: string | null = null
  let tokenDuringDelete: string | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request
      events.push(`http:${req.method}:${new URL(req.url).pathname}`)
      observedAuthHeader = req.headers.get('Authorization')
      keyDuringDelete = localStorage.getItem(PUSH_DEVICE_KEY)
      tokenDuringDelete = state.token
      return new Response(null, { status: 204 })
    })
  )

  const originalRemoveItem = Storage.prototype.removeItem
  const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key: string
  ) {
    if (key === PUSH_DEVICE_KEY) events.push('remove-push-device-key')
    if (key === 'kodera.web.auth.returnTo') events.push('session-cleared')
    originalRemoveItem.call(this, key)
  })

  const state: { user: AuthUser | undefined; token: string | undefined } = {
    user: { realm: 'acme-sa' },
    token: 'user-a-bearer-token',
  }
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    user: state.user,
    generation: 0,
    credentialGeneration: 1,
  }
  const listeners = new Set<() => void>()
  const adapter: AuthAdapter = {
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    restoreSession: async () => true,
    getAccessToken: () => state.token,
    getUser: () => state.user,
    signIn: async () => {},
    handleCallback: async () => 'interactive',
    signOut: async () => {
      events.push('token-cleared')
      state.user = undefined
      state.token = undefined
      snapshot = {
        status: 'unauthenticated',
        user: undefined,
        generation: 1,
        credentialGeneration: 2,
      }
      listeners.forEach((l) => l())
    },
    onExpiring: () => () => {},
    getExpiresAt: () => undefined,
    renew: async () => false,
    onRenewed: () => () => {},
    onRenewalFailed: () => () => {},
  }

  try {
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => createElement(AuthProvider, { adapter, children }),
    })

    await act(async () => {
      await result.current.signOut()
    })

    expect(unsubscribePush).toHaveBeenCalledOnce()
    expect(deleteCache).toHaveBeenCalledWith(PUSH_COPY_CACHE)
    expect(observedAuthHeader).toBe('Bearer user-a-bearer-token')
    expect(tokenDuringDelete).toBe('user-a-bearer-token')
    expect(keyDuringDelete).toBe(deviceUuid)
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBeNull()
    expect(events).toEqual([
      `http:DELETE:/api/v1/push/subscriptions/${deviceUuid}`,
      'unsubscribe',
      `cache-delete:${PUSH_COPY_CACHE}`,
      'remove-push-device-key',
      'token-cleared',
      'session-cleared',
    ])
  } finally {
    removeSpy.mockRestore()
    Reflect.deleteProperty(window.navigator, 'serviceWorker')
  }
})

it('fences NotificationFeed.markRead rollback across reset so pre-logout notifications never reappear on failure', async () => {
  let rejectMarkRead!: (reason?: unknown) => void
  const feed = new NotificationFeed(
    async () => ({
      data: [
        {
          id: 'notif-pre-logout',
          resourceId: 'res-pre-logout',
          kind: 'mention',
          createdAt: '2026-01-01T10:00:00Z',
          readAt: null,
        },
      ],
    }),
    () =>
      new Promise((_resolve, reject) => {
        rejectMarkRead = reject
      })
  )

  await feed.refresh()
  expect(feed.getSnapshot().items).toHaveLength(1)
  expect(feed.getSnapshot().unread).toBe(1)

  const markPromise = feed.markRead(['notif-pre-logout'])
  expect(feed.getSnapshot().unread).toBe(0)

  feed.reset()
  expect(feed.getSnapshot()).toEqual({ status: 'loading', items: [], unread: 0 })

  rejectMarkRead(new Error('network failure after sign-out'))
  await markPromise

  expect(feed.getSnapshot()).toEqual({ status: 'loading', items: [], unread: 0 })
})

it('fences UnfurlCache in-flight requests across reset so pre-logout responses cannot populate a later user request', async () => {
  const resolvers: Array<(value: unknown) => void> = []
  const cache = new UnfurlCache(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
  )

  const sharedUrl = 'https://kodera.io/shared'
  cache.request('org-1', sharedUrl)
  expect(resolvers).toHaveLength(1)

  // Sign-out resets the cache while User A's unfurl request is still in flight.
  cache.reset()

  // User B requests the same org/URL after signing in.
  cache.request('org-1', sharedUrl)
  expect(resolvers).toHaveLength(2)

  // User A's stale pre-logout response settles first and must be ignored.
  resolvers[0]!({
    url: sharedUrl,
    site: 'kodera.io',
    title: 'User A Private Preview',
    description: 'Leaked',
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(cache.card('org-1', sharedUrl)).toBeUndefined()

  // User B's own request settles and populates cleanly.
  resolvers[1]!({
    url: sharedUrl,
    site: 'kodera.io',
    title: 'User B Preview',
    description: 'Authorized',
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(cache.card('org-1', sharedUrl)?.title).toBe('User B Preview')
})

it('runs fallback browser push unsubscribe in clearLocalSessionStorage when disablePush fails to unsubscribe during signOut', async () => {
  import.meta.env['VITE_CORE_API_URL'] = 'https://core-push-fallback.example.test/api/v1'
  const deviceUuid = '22222222-3333-4444-8555-666666666666'
  localStorage.setItem(PUSH_DEVICE_KEY, deviceUuid)

  const unsubscribeFallback = vi.fn(async () => true)
  let registrationAttempts = 0
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', { permission: 'granted' })
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => {
        registrationAttempts += 1
        // First lookup inside disablePush() rejects; fallback in clearLocalSessionStorage() succeeds.
        if (registrationAttempts === 1) throw new Error('transient sw lookup error')
        return {
          pushManager: {
            getSubscription: vi.fn(async () => ({ unsubscribe: unsubscribeFallback })),
          },
          active: { postMessage: vi.fn() },
        }
      }),
    },
  })
  vi.stubGlobal('caches', { delete: vi.fn(async () => true) })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  )

  const state: { user: AuthUser | undefined; token: string | undefined } = {
    user: { realm: 'acme-sa' },
    token: 'user-a-bearer-token',
  }
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    user: state.user,
    generation: 0,
    credentialGeneration: 1,
  }
  const listeners = new Set<() => void>()
  const adapter: AuthAdapter = {
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    restoreSession: async () => true,
    getAccessToken: () => state.token,
    getUser: () => state.user,
    signIn: async () => {},
    handleCallback: async () => 'interactive',
    signOut: async () => {
      state.user = undefined
      state.token = undefined
      snapshot = {
        status: 'unauthenticated',
        user: undefined,
        generation: 1,
        credentialGeneration: 2,
      }
      listeners.forEach((l) => l())
    },
    onExpiring: () => () => {},
    getExpiresAt: () => undefined,
    renew: async () => false,
    onRenewed: () => () => {},
    onRenewalFailed: () => () => {},
  }

  try {
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => createElement(AuthProvider, { adapter, children }),
    })
    await act(async () => {
      await result.current.signOut()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unsubscribeFallback).toHaveBeenCalledOnce()
  } finally {
    Reflect.deleteProperty(window.navigator, 'serviceWorker')
  }
})

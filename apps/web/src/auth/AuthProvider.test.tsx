import type * as ReactModule from 'react'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthSessionSnapshot, AuthUser } from '@/auth/AuthAdapter'
import {
  AuthProvider,
  PUSH_MODULE_LOAD_TIMEOUT_MS,
  useAuth,
  useAuthLifetime,
} from '@/auth/AuthProvider'
import { PUSH_DEVICE_KEY } from '@/features/notifications/pushState'
import * as matrixAuth from '@/auth/matrix'
import { coreApi, NetworkError } from '@/api/client'
import { authAdapter as defaultAuthAdapter } from './oidc'

// Opt-in AP2 observes the actual provider-owned React subscription records.
// The real React hook order and dispatcher remain in use for every case.
const draftReactControl = vi.hoisted(() => ({ enabled: false, order: [] as string[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useSyncExternalStore<T>(
      subscribe: (notify: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T
    ) {
      const wrapped = actual.useCallback(
        (notify: () => void) => {
          if (!draftReactControl.enabled) return subscribe(notify)
          const removeThrow = subscribe(() => {
            draftReactControl.order.push('react-throw')
            throw new Error('fixed private React observer sentinel')
          })
          const removeLive = subscribe(() => {
            draftReactControl.order.push('react-live')
            notify()
          })
          return () => {
            removeThrow()
            removeLive()
          }
        },
        [subscribe]
      )
      return actual.useSyncExternalStore(wrapped, getSnapshot, getServerSnapshot)
    },
  }
})

import.meta.env['VITE_CORE_API_URL'] = 'https://core.example.test/api/v1'

function fakeAdapter(
  initial?: AuthUser,
  initialToken?: string
): AuthAdapter & { user: AuthUser | undefined } {
  const state = { user: initial, token: initialToken }
  let snapshot: AuthSessionSnapshot = {
    status: initial ? 'ready' : 'unauthenticated',
    user: initial,
    generation: 0,
    credentialGeneration: initialToken === undefined ? 0 : 1,
  }
  const listeners = new Set<() => void>()
  const publish = () => {
    snapshot = {
      status: state.user ? 'ready' : 'unauthenticated',
      user: state.user,
      generation: snapshot.generation + 1,
      credentialGeneration: snapshot.credentialGeneration + 1,
    }
    listeners.forEach((listener) => listener())
  }
  return {
    get user() {
      return state.user
    },
    set user(value) {
      state.user = value
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    restoreSession: async () => state.user !== undefined,
    getAccessToken: () => state.token,
    getUser: () => state.user,
    signIn: vi.fn(async () => {}),
    handleCallback: vi.fn(async () => {
      state.user = { realm: 'acme-sa' }
      state.token = 'token-from-callback'
      publish()
      return 'interactive' as const
    }),
    signOut: vi.fn(async () => {
      state.user = undefined
      state.token = undefined
      publish()
    }),
    onExpiring: vi.fn(() => () => {}),
    getExpiresAt: () => undefined,
    renew: vi.fn(async () => false),
    onRenewed: vi.fn(() => () => {}),
    onRenewalFailed: vi.fn(() => () => {}),
  }
}

function Probe() {
  const auth = useAuth()
  return (
    <div>
      <p data-testid="authenticated">{String(auth.isAuthenticated)}</p>
      <p data-testid="credential-generation">{auth.credentialGeneration}</p>
      <button onClick={() => void auth.handleCallback()}>callback</button>
      <button onClick={() => void auth.signOut()}>sign out</button>
    </div>
  )
}

describe('AuthProvider / useAuth', () => {
  it('starts unauthenticated when the adapter has no session', () => {
    render(
      <AuthProvider adapter={fakeAdapter()}>
        <Probe />
      </AuthProvider>
    )
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('starts authenticated when the adapter already has a session', () => {
    render(
      <AuthProvider adapter={fakeAdapter({ realm: 'acme-sa' }, 'existing')}>
        <Probe />
      </AuthProvider>
    )
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
  })

  it('becomes authenticated after handleCallback resolves', async () => {
    const user = userEvent.setup()
    render(
      <AuthProvider adapter={fakeAdapter()}>
        <Probe />
      </AuthProvider>
    )
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    await user.click(screen.getByRole('button', { name: 'callback' }))
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
  })

  it('does not publish a session after silent callback notification', async () => {
    const adapter = fakeAdapter()
    vi.mocked(adapter.handleCallback).mockImplementation(async () => {
      adapter.user = { realm: 'acme-sa' }
      return 'silent'
    })
    render(
      <AuthProvider adapter={adapter}>
        <Probe />
      </AuthProvider>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'callback' }))
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('publishes a credential boundary separately from a full session boundary', () => {
    const adapter = fakeAdapter({ realm: 'acme-sa' }, 'initial')
    let snapshot = adapter.getSnapshot()
    let notify!: () => void
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(() => snapshot)
    vi.spyOn(adapter, 'subscribe').mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    const clearCache = vi.fn()
    const clearCurrentUser = vi.fn()
    render(
      <AuthProvider
        adapter={adapter}
        onSessionEnded={clearCache}
        onCredentialChanged={clearCurrentUser}
      >
        <Probe />
      </AuthProvider>
    )
    act(() => {
      snapshot = {
        ...snapshot,
        user: { realm: 'acme-sa' },
        credentialGeneration: snapshot.credentialGeneration + 1,
      }
      notify()
    })
    expect(clearCache).not.toHaveBeenCalled()
    expect(clearCurrentUser).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('credential-generation')).toHaveTextContent('2')
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
    act(() => {
      snapshot = {
        status: 'pending',
        user: undefined,
        generation: snapshot.generation + 1,
        credentialGeneration: snapshot.credentialGeneration + 1,
      }
      notify()
    })
    expect(clearCache).toHaveBeenCalledTimes(1)
    expect(clearCurrentUser).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('becomes unauthenticated after signOut resolves', async () => {
    const user = userEvent.setup()
    render(
      <AuthProvider adapter={fakeAdapter({ realm: 'acme-sa' }, 'existing')}>
        <Probe />
      </AuthProvider>
    )
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
    await user.click(screen.getByRole('button', { name: 'sign out' }))
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('closes the local session boundary before SDK cleanup settles', async () => {
    // The adapter's own token boundary is proven at the adapter level
    // (`oidc.test.ts`); this pins the provider's half: cache (`onSessionEnded`)
    // and console-owned storage are gone while the SDK's cleanup promise is
    // still pending, so a slow or failing identity provider can never leave
    // the previous identity's content on screen.
    const sequence: string[] = []
    const adapter = fakeAdapter({ realm: 'acme-sa' }, 'existing')
    vi.mocked(adapter.signOut).mockImplementation(() => {
      sequence.push('sdk-cleanup-started')
      return new Promise<void>(() => {})
    })
    const onSessionEnded = vi.fn(() => {
      sequence.push('session-ended')
    })
    sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home')
    const originalRemoveItem = Storage.prototype.removeItem
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      sequence.push(`storage-cleared:${key}`)
      originalRemoveItem.call(this, key)
    })
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => (
        <AuthProvider adapter={adapter} onSessionEnded={onSessionEnded}>
          {children}
        </AuthProvider>
      ),
    })

    const signingOut = result.current.signOut()
    const settled = await Promise.race([
      signingOut.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])

    expect(settled).toBe('pending')
    expect(sequence).toEqual([
      'sdk-cleanup-started',
      'session-ended',
      'storage-cleared:kodera.web.auth.sharedRealmSlugs',
      'storage-cleared:kodera.web.auth.returnTo',
    ])
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
    removeItem.mockRestore()
  })

  it('invokes signOutOfMatrix before clearLocalSessionStorage without awaiting a slow homeserver', async () => {
    const sequence: string[] = []
    const adapter = fakeAdapter({ realm: 'acme-sa' }, 'existing')
    const onMatrixClear = vi.fn(() => {
      sequence.push('matrix-memory-cleared')
    })
    matrixAuth.registerMatrixSession(
      {
        baseUrl: 'https://matrix.acme-sa.kodera.io',
        userId: '@sub-1:acme-sa.kodera.io',
        deviceId: 'KODERADEV',
        accessToken: 'syt_latest_token',
        refreshToken: 'syr_latest_refresh',
        refresh: vi.fn(),
      },
      onMatrixClear
    )
    localStorage.setItem('kodera.web.espace.device:https://matrix.acme-sa.kodera.io', 'KODERADEV')
    sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/workspace')

    const signOutSpy = vi
      .spyOn(matrixAuth, 'signOutOfMatrix')
      .mockImplementation((baseUrl, token) => {
        sequence.push(`matrix-signout:${baseUrl}:${token}`)
        // Simulate a homeserver that never answers before Console signOut finishes.
        return new Promise<void>(() => {})
      })

    const originalRemoveItem = Storage.prototype.removeItem
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      sequence.push(`storage-cleared:${key}`)
      originalRemoveItem.call(this, key)
    })

    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => <AuthProvider adapter={adapter}>{children}</AuthProvider>,
    })

    await act(async () => {
      await result.current.signOut()
    })

    expect(matrixAuth.getMatrixSession()).toBeUndefined()
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(onMatrixClear).toHaveBeenCalledTimes(1)
    expect(signOutSpy).toHaveBeenCalledWith('https://matrix.acme-sa.kodera.io', 'syt_latest_token')
    const matrixCallIndex = sequence.indexOf(
      'matrix-signout:https://matrix.acme-sa.kodera.io:syt_latest_token'
    )
    const firstStorageClearIndex = sequence.findIndex((entry) =>
      entry.startsWith('storage-cleared:')
    )
    expect(matrixCallIndex).toBeGreaterThanOrEqual(0)
    expect(firstStorageClearIndex).toBeGreaterThan(matrixCallIndex)
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(0)

    removeItem.mockRestore()
    signOutSpy.mockRestore()
  })

  it('wires the Core API client token provider to the adapter (ADR-0007)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <AuthProvider adapter={fakeAdapter({ realm: 'acme-sa' }, 'wired-token')}>
        <Probe />
      </AuthProvider>
    )

    // No screen may reach a token any other way; this is the one seam that
    // does — the client asks for a bearer token on every request through
    // whatever `setTokenProvider` was last given.
    await coreApi().GET('/me')
    const request = fetchSpy.mock.calls[0]?.[0] as Request
    expect(request.headers.get('Authorization')).toBe('Bearer wired-token')

    vi.unstubAllGlobals()
  })

  it('publishes fresh same-identity snapshots without retiring draft ownership', () => {
    const actual = controlledDraftAdapter()
    const initial = actual.adapter.getSnapshot()
    const ended = vi.fn()
    const credential = vi.fn()
    const { result, unmount } = renderHook(
      () => ({ auth: useAuth(), lifetime: useAuthLifetime() }),
      {
        wrapper: ({ children }) => (
          <AuthProvider
            adapter={actual.adapter}
            onSessionEnded={ended}
            onCredentialChanged={credential}
          >
            {children}
          </AuthProvider>
        ),
      }
    )
    const port = result.current.lifetime
    const stamp = port.getRetirementStamp()
    const observedUsers: (AuthUser | undefined)[] = []
    const remove = port.subscribe(() => {
      observedUsers.push(port.getSnapshot().user)
    })
    try {
      expect(result.current.auth.user).toBe(initial.user)
      const userB = { ...initial.user! }
      const fresh = { ...initial, user: userB }
      expect(userB).toEqual(initial.user)
      expect(userB).not.toBe(initial.user)
      act(() => actual.publish(fresh, 'usable'))
      expect(result.current.auth.user, 'FreshSnapshotWasSuppressed').toBe(userB)
      expect(observedUsers).toHaveLength(1)
      expect(observedUsers[0]).toBe(userB)
      expect(port.getRetirementStamp()).toBe(stamp)
      expect(ended).not.toHaveBeenCalled()
      expect(credential).not.toHaveBeenCalled()

      act(() => actual.publish(fresh, 'usable'))
      expect(result.current.auth.user).toBe(userB)
      expect(observedUsers).toHaveLength(1)
      expect(port.getRetirementStamp()).toBe(stamp)
      expect(ended).not.toHaveBeenCalled()
      expect(credential).not.toHaveBeenCalled()
    } finally {
      remove()
      unmount()
    }
    expect(actual.listeners.size).toBe(0)
  })

  it('useAuth throws outside an AuthProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useAuth must be used within an AuthProvider')
    consoleError.mockRestore()
  })
})

function controlledDraftAdapter() {
  const adapter = fakeAdapter(
    { realm: 'acme-sa', identity: { issuer: 'https://issuer.test', subject: 'person-a' } },
    'usable'
  )
  let snapshot = adapter.getSnapshot()
  let token: string | undefined = 'usable'
  const listeners = new Set<() => void>()
  adapter.getSnapshot = () => snapshot
  adapter.getAccessToken = () => token
  adapter.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    adapter,
    listeners,
    publish(next: AuthSessionSnapshot, nextToken: string | undefined) {
      snapshot = next
      token = nextToken
      for (const listener of [...listeners]) listener()
    },
  }
}

it('draft_lifetime_uses_the_actual_injected_adapter', () => {
  const actual = controlledDraftAdapter()
  const contradictory = fakeAdapter({ realm: 'other' }, 'global-ready')
  const globalSnapshot = vi
    .spyOn(defaultAuthAdapter, 'getSnapshot')
    .mockImplementation(contradictory.getSnapshot)
  const globalToken = vi.spyOn(defaultAuthAdapter, 'getAccessToken').mockReturnValue('global-ready')
  let suppliedAdapter: AuthAdapter = actual.adapter
  const { result, rerender, unmount } = renderHook(useAuthLifetime, {
    wrapper: ({ children }) => <AuthProvider adapter={suppliedAdapter}>{children}</AuthProvider>,
  })
  const lifetime = result.current
  try {
    expect(lifetime.getSnapshot()).toBe(actual.adapter.getSnapshot())
    expect(lifetime.getSnapshot().user?.identity?.subject).toBe('person-a')
    expect(lifetime.hasUsableCredential()).toBe(true)
    act(() => actual.publish(actual.adapter.getSnapshot(), undefined))
    expect(lifetime.hasUsableCredential()).toBe(false)
    suppliedAdapter = contradictory
    rerender()
    expect(result.current).toBe(lifetime)
    expect(lifetime.getSnapshot().user?.realm).toBe('acme-sa')
    expect(lifetime.hasUsableCredential()).toBe(false)
    expect(Object.keys(lifetime).sort()).toEqual([
      'getRetirementStamp',
      'getSnapshot',
      'hasUsableCredential',
      'subscribe',
    ])
    expect(globalSnapshot).not.toHaveBeenCalled()
    expect(globalToken).not.toHaveBeenCalled()
  } finally {
    unmount()
    globalSnapshot.mockRestore()
    globalToken.mockRestore()
  }
  expect(actual.listeners.size).toBe(0)
})

it('draft_lifetime_observes_current_usability_and_unsubscribes', () => {
  draftReactControl.enabled = true
  draftReactControl.order.length = 0
  const actual = controlledDraftAdapter()
  const ended = vi.fn(() => {
    throw new Error('private ended sentinel')
  })
  const credential = vi.fn(() => {
    throw new Error('private credential sentinel')
  })
  const { result, unmount } = renderHook(
    () => ({ lifetime: useAuthLifetime(), credential: useAuth().credentialGeneration }),
    {
      wrapper: ({ children }) => (
        <AuthProvider
          adapter={actual.adapter}
          onSessionEnded={ended}
          onCredentialChanged={credential}
        >
          {children}
        </AuthProvider>
      ),
    }
  )
  const port = result.current.lifetime
  const firstStamp = port.getRetirementStamp()
  const observations: object[] = []
  const removeThrow = port.subscribe(() => {
    draftReactControl.order.push('priority-throw')
    throw new Error('private observer sentinel')
  })
  let reenter = false
  const removeEarlier = port.subscribe(() => {
    if (reenter) {
      reenter = false
      actual.publish(actual.adapter.getSnapshot(), undefined)
      actual.publish(actual.adapter.getSnapshot(), 'restored')
    }
  })
  const remove = port.subscribe(() => {
    draftReactControl.order.push('priority-draft')
    observations.push(port.getRetirementStamp())
  })
  try {
    expect(actual.listeners.size).toBe(1)
    draftReactControl.order.length = 0
    expect(() =>
      act(() =>
        actual.publish({ ...actual.adapter.getSnapshot(), credentialGeneration: 2 }, 'rotation')
      )
    ).not.toThrow()
    expect(result.current.credential).toBe(2)
    expect(draftReactControl.order.indexOf('priority-draft')).toBeGreaterThanOrEqual(0)
    expect(draftReactControl.order.indexOf('react-throw')).toBeGreaterThan(
      draftReactControl.order.indexOf('priority-draft')
    )
    expect(draftReactControl.order.indexOf('react-live')).toBeGreaterThan(
      draftReactControl.order.indexOf('react-throw')
    )
    expect(port.getRetirementStamp()).toBe(firstStamp)
    expect(credential).toHaveBeenCalledTimes(1)
    reenter = true
    act(() =>
      actual.publish({ ...actual.adapter.getSnapshot(), credentialGeneration: 3 }, 'usable')
    )
    expect(port.hasUsableCredential()).toBe(true)
    expect(port.getRetirementStamp()).not.toBe(firstStamp)
    expect(observations.at(-1)).toBe(port.getRetirementStamp())
    act(() =>
      actual.publish(
        { status: 'unauthenticated', user: undefined, generation: 1, credentialGeneration: 4 },
        undefined
      )
    )
    expect(ended).toHaveBeenCalledTimes(1)
    expect(port.getSnapshot().status).toBe('unauthenticated')
    const count = observations.length
    remove()
    remove()
    removeEarlier()
    removeThrow()
    act(() => actual.publish({ ...actual.adapter.getSnapshot(), generation: 2 }, undefined))
    expect(observations).toHaveLength(count)
    unmount()
    expect(actual.listeners.size).toBe(0)
  } finally {
    remove()
    removeEarlier()
    removeThrow()
    unmount()
    draftReactControl.enabled = false
    draftReactControl.order.length = 0
  }
})

it('draft_observer_failure_does_not_skip_signout_steps', async () => {
  for (const mode of ['held', 'rejected', 'synchronous', 'success'] as const) {
    const actual = controlledDraftAdapter()
    const target = {
      baseUrl: 'https://matrix.acme-sa.kodera.io',
      userId: '@person-a:acme-sa.kodera.io',
      deviceId: 'device',
      accessToken: 'prepared-token',
      refreshToken: 'refresh',
      refresh: vi.fn(),
    }
    matrixAuth.registerMatrixSession(target)
    const replacementStop = vi.fn()
    let release = () => {}
    vi.mocked(actual.adapter.signOut).mockImplementation(() => {
      matrixAuth.clearMatrixSession()
      target.accessToken = 'replacement-token'
      matrixAuth.registerMatrixSession(target, replacementStop)
      if (mode === 'synchronous') throw new Error('sdk synchronous')
      if (mode === 'rejected') return Promise.reject(new Error('sdk rejected'))
      if (mode === 'held')
        return new Promise<void>((resolve) => {
          release = resolve
        })
      return Promise.resolve()
    })
    const revoke = vi.spyOn(matrixAuth, 'signOutOfMatrix').mockResolvedValue(undefined)
    const { result, unmount } = renderHook(
      () => ({ auth: useAuth(), lifetime: useAuthLifetime() }),
      {
        wrapper: ({ children }) => (
          <AuthProvider
            adapter={actual.adapter}
            onSessionEnded={() => {
              throw new Error('ended')
            }}
          >
            {children}
          </AuthProvider>
        ),
      }
    )
    const remove = result.current.lifetime.subscribe(() => {
      throw new Error('observer')
    })
    const stamp = result.current.lifetime.getRetirementStamp()
    sessionStorage.setItem('kodera.web.auth.returnTo', '/owned')
    let settled = false
    const promise = result.current.auth.signOut().then(
      () => {
        settled = true
        return 'ok'
      },
      () => {
        settled = true
        return 'rejected'
      }
    )
    try {
      expect(result.current.lifetime.getRetirementStamp()).not.toBe(stamp)
      expect(revoke).toHaveBeenCalledWith(target.baseUrl, 'prepared-token')
      expect(matrixAuth.getMatrixSession()).toBe(target)
      expect(replacementStop).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
      if (mode === 'held') expect(settled).toBe(false)
    } finally {
      release()
      expect(await promise).toBe(mode === 'rejected' || mode === 'synchronous' ? 'rejected' : 'ok')
      remove()
      unmount()
      revoke.mockRestore()
      matrixAuth.clearMatrixSession()
    }
  }
})

it('completes credential revocation, Matrix sign-out, and local storage wipe when the lazy push module load stalls', async () => {
  vi.useFakeTimers()
  const adapter = fakeAdapter({ realm: 'acme-sa' }, 'stalled-push-token')
  const onSessionEnded = vi.fn()
  const lateDisablePush = vi.fn(async () => true)
  let resolvePushLoad: ((mod: { disablePush: typeof lateDisablePush }) => void) | undefined
  const stalledLoadPush = vi.fn(
    () =>
      new Promise<{ disablePush: typeof lateDisablePush }>((resolve) => {
        resolvePushLoad = resolve
      })
  )
  matrixAuth.registerMatrixSession({
    baseUrl: 'https://matrix.acme-sa.kodera.io',
    userId: '@person-a:acme-sa.kodera.io',
    deviceId: 'KODERADEV',
    accessToken: 'syt_stalled_token',
    refreshToken: 'syr_stalled_refresh',
    refresh: vi.fn(),
  })
  const revoke = vi.spyOn(matrixAuth, 'signOutOfMatrix').mockResolvedValue(undefined)
  localStorage.setItem(PUSH_DEVICE_KEY, '11111111-2222-4333-8444-555555555555')
  sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home')

  const { result, unmount } = renderHook(() => ({ auth: useAuth(), lifetime: useAuthLifetime() }), {
    wrapper: ({ children }) => (
      <AuthProvider
        adapter={adapter}
        loadPushModule={stalledLoadPush}
        onSessionEnded={onSessionEnded}
      >
        {children}
      </AuthProvider>
    ),
  })
  const initialStamp = result.current.lifetime.getRetirementStamp()
  const nativeOk = { status: 200, headers: {}, body_base64: btoa('{}') }
  const finishes: Array<(value: typeof nativeOk) => void> = []
  const invoke = vi
    .fn()
    .mockImplementation(() =>
      finishes.length < 6
        ? new Promise<typeof nativeOk>((resolve) => finishes.push(resolve))
        : Promise.resolve(nativeOk)
    )
  const bundledWindow = Object.create(window) as Window
  Object.defineProperties(bundledWindow, {
    location: { value: new URL('kodera-asset://localhost/') },
    koderaDesktop: { value: { invoke } },
  })
  vi.stubGlobal('window', bundledWindow)
  const active = Array.from({ length: 6 }, () => coreApi().GET('/me'))
  try {
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(6))
    let subscriptions: ReturnType<typeof vi.spyOn> | undefined
    const queued = coreApi()
      .GET('/me', {
        middleware: [
          {
            onRequest({ request }) {
              expect(request.headers.get('Authorization')).toBe('Bearer stalled-push-token')
              subscriptions = vi.spyOn(request.signal, 'addEventListener')
              return request
            },
          },
        ],
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(subscriptions?.mock.calls).toHaveLength(1))
    let settled = false
    const signOutPromise = result.current.auth.signOut().then(() => {
      settled = true
    })

    // Synchronous retirement happens immediately before awaiting the push chunk.
    expect(result.current.lifetime.getRetirementStamp()).not.toBe(initialStamp)
    expect(stalledLoadPush).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    // Release the pre-sign-out FIFO waiter while push teardown still owns the token.
    finishes.forEach((finish) => finish(nativeOk))
    await Promise.all(active)
    const refused = await queued
    expect(refused).toBeInstanceOf(NetworkError)
    expect((refused as NetworkError).cause).toBe('core_api_aborted')
    expect(
      invoke.mock.calls.filter(([command]) => command === 'desktop_core_api_request')
    ).toHaveLength(6)
    expect(settled).toBe(false)
    expect(adapter.getAccessToken()).toBe('stalled-push-token')

    // Work created during push teardown captures the new generation.
    await coreApi().GET('/me')
    expect(
      invoke.mock.calls.filter(([command]) => command === 'desktop_core_api_request')
    ).toHaveLength(7)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUSH_MODULE_LOAD_TIMEOUT_MS - 1)
    })
    expect(settled).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
      await signOutPromise
    })

    expect(settled).toBe(true)
    expect(adapter.signOut).toHaveBeenCalledTimes(1)
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(onSessionEnded).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('https://matrix.acme-sa.kodera.io', 'syt_stalled_token')
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).toBeNull()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()

    // Even if the stalled chunk eventually arrives later, it never runs teardown after timeout.
    resolvePushLoad?.({ disablePush: lateDisablePush })
    await act(async () => {
      await Promise.resolve()
    })
    expect(lateDisablePush).not.toHaveBeenCalled()
  } finally {
    unmount()
    revoke.mockRestore()
    matrixAuth.clearMatrixSession()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it('account-switch-purge and logout-purge: wipes kodera.espace-vault.v1, kodera-espace-timelines, and kodera-docs-yjs:* when principal switches or signs out', async () => {
  const { openEspaceVault } = await import('@/features/espace/matrix/encryptedCache')
  const { createTestVaultIndexedDb } = await import('@/features/espace/matrix/testVaultIdb')
  const {
    DOCS_COLLAB_REGISTRY_KEY,
    ESPACE_TIMELINE_DATABASE,
    ESPACE_VAULT_DATABASE,
    registerDocsCollabCleanup,
  } = await import('@/auth/localSession')

  const idb = createTestVaultIndexedDb()
  vi.stubGlobal('indexedDB', idb)

  const openSeedDb = (name: string) =>
    new Promise<void>((resolve) => {
      const req = idb.open(name, 1)
      req.onsuccess = () => {
        req.result.close()
        resolve()
      }
    })

  const actual = controlledDraftAdapter()
  const vaultA = await openEspaceVault(
    {
      ownerId: '@person-a:acme-sa.kodera.io',
      organisationId: 'acme-sa',
      membershipId: 'mem-a',
      deviceId: 'DEV_A',
    },
    { idb, delayMs: 0 }
  )
  await vaultA.putDraft('!room-a:acme-sa.kodera.io', 'ordinary', 'person-a-draft', '')
  await openSeedDb('kodera-docs-yjs:acme-sa:doc-person-a')
  localStorage.setItem(
    DOCS_COLLAB_REGISTRY_KEY,
    JSON.stringify(['kodera-docs-yjs:acme-sa:doc-person-a'])
  )
  const docsCleanupA = vi.fn()
  const unregisterDocsA = registerDocsCollabCleanup(docsCleanupA)
  idb.deletedDatabases.length = 0

  const { result, unmount } = renderHook(() => ({ auth: useAuth() }), {
    wrapper: ({ children }) => <AuthProvider adapter={actual.adapter}>{children}</AuthProvider>,
  })

  try {
    // 1. Account / principal switch (`person-a` -> `person-b`) immediately purges Espace vault + Yjs docs DBs!
    act(() => {
      actual.publish(
        {
          status: 'ready',
          user: {
            realm: 'acme-sa',
            identity: { issuer: 'https://issuer.test', subject: 'person-b' },
          },
          generation: 1,
          credentialGeneration: 2,
        },
        'person-b-token'
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(docsCleanupA).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)).toBeNull()
    expect(idb.deletedDatabases).toContain(ESPACE_VAULT_DATABASE)
    expect(idb.deletedDatabases).toContain(ESPACE_TIMELINE_DATABASE)
    expect(idb.deletedDatabases).toContain('kodera-docs-yjs:acme-sa:doc-person-a')
    expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(false)
    expect(idb.hasDatabase('kodera-docs-yjs:acme-sa:doc-person-a')).toBe(false)
    await expect(vaultA.readDraft('!room-a:acme-sa.kodera.io')).rejects.toMatchObject({
      code: 'closed',
    })
    unregisterDocsA()

    // 2. Person B opens a fresh vault + Yjs doc, then explicit `signOut()` wipes both again!
    const vaultB = await openEspaceVault(
      {
        ownerId: '@person-b:acme-sa.kodera.io',
        organisationId: 'acme-sa',
        membershipId: 'mem-b',
        deviceId: 'DEV_B',
      },
      { idb, delayMs: 0 }
    )
    await vaultB.putDraft('!room-b:acme-sa.kodera.io', 'ordinary', 'person-b-draft', '')
    await openSeedDb('kodera-docs-yjs:acme-sa:doc-person-b')
    const docsCleanupB = vi.fn()
    const unregisterDocsB = registerDocsCollabCleanup(docsCleanupB)
    idb.deletedDatabases.length = 0

    await act(async () => {
      await result.current.auth.signOut()
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(docsCleanupB).toHaveBeenCalled()
    expect(idb.deletedDatabases).toContain(ESPACE_VAULT_DATABASE)
    expect(idb.deletedDatabases).toContain(ESPACE_TIMELINE_DATABASE)
    expect(idb.deletedDatabases).toContain('kodera-docs-yjs:acme-sa:doc-person-b')
    expect(idb.hasDatabase(ESPACE_VAULT_DATABASE)).toBe(false)
    expect(idb.hasDatabase('kodera-docs-yjs:acme-sa:doc-person-b')).toBe(false)
    await expect(vaultB.readDraft('!room-b:acme-sa.kodera.io')).rejects.toMatchObject({
      code: 'closed',
    })
    unregisterDocsB()
  } finally {
    unregisterDocsA()
    unmount()
    vi.unstubAllGlobals()
  }
})

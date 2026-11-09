import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSessionSnapshot } from './AuthAdapter'

const state = vi.hoisted(() => ({
  token: 'current' as string | undefined,
  snapshot: {
    status: 'ready',
    user: { realm: 'acme-sa' },
    generation: 0,
    credentialGeneration: 1,
  } as AuthSessionSnapshot,
  listeners: new Set<() => void>(),
  expiresAt: 0,
  expiring: new Set<() => void>(),
  renewed: new Set<() => void>(),
  failed: new Set<() => void>(),
  renew: vi.fn<() => Promise<boolean>>(),
}))
vi.mock('./oidc', () => ({
  authAdapter: {
    getSnapshot: () => state.snapshot,
    subscribe: (listener: () => void) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    restoreSession: async () => state.token !== undefined,
    getAccessToken: () => state.token,
    getExpiresAt: () => state.expiresAt,
    getUser: () => state.snapshot.user,
    signIn: vi.fn(),
    signOut: async () => {
      state.token = undefined
      state.snapshot = {
        status: 'unauthenticated',
        user: undefined,
        generation: state.snapshot.generation + 1,
        credentialGeneration: state.snapshot.credentialGeneration + 1,
      }
      state.listeners.forEach((listener) => listener())
    },
    handleCallback: vi.fn(),
    renew: state.renew,
    onExpiring: (callback: () => void) => {
      state.expiring.add(callback)
      return () => state.expiring.delete(callback)
    },
    onRenewed: (callback: () => void) => {
      state.renewed.add(callback)
      return () => state.renewed.delete(callback)
    },
    onRenewalFailed: (callback: () => void) => {
      state.failed.add(callback)
      return () => state.failed.delete(callback)
    },
  },
}))
import { AuthProvider, useAuth } from './AuthProvider'
import { SessionExpiryProvider, useSessionExpiryDialog } from './sessionExpiry'
import { onBeforeSignIn } from './beforeSignIn'
import { authAdapter } from './oidc'

function Probe() {
  const session = useSessionExpiryDialog()
  const auth = useAuth()
  return (
    <>
      <output data-testid="expiry">{session.expiring ? session.remainingS : 'closed'}</output>
      <button onClick={session.extend}>extend</button>
      <button onClick={session.dismiss}>dismiss</button>
      <button onClick={() => void auth.signOut()}>logout</button>
    </>
  )
}
function start() {
  render(
    <AuthProvider>
      <SessionExpiryProvider>
        <Probe />
      </SessionExpiryProvider>
    </AuthProvider>
  )
  act(() => {
    state.expiring.forEach((callback) => callback())
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  state.token = 'current'
  state.snapshot = {
    status: 'ready',
    user: { realm: 'acme-sa' },
    generation: 0,
    credentialGeneration: 1,
  }
  state.listeners.clear()
  state.expiresAt = Date.now() + 120_000
  state.expiring.clear()
  state.renewed.clear()
  state.failed.clear()
  state.renew.mockReset().mockResolvedValue(false)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('session renewal and expiry', () => {
  it('never warns for failed focus or periodic renewals while more than 120 seconds remain', async () => {
    state.expiresAt = Date.now() + 3_600_000
    start()
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      state.failed.forEach((callback) => callback())
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
    act(() => {
      state.expiresAt = Date.now() + 120_000
      state.failed.forEach((callback) => callback())
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('120')
  })

  it.each(['failure', 'rejection'])(
    'dismisses immediately and stays dismissed after renewal %s until actual expiry',
    async (outcome) => {
      let finish!: () => void
      state.renew.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === 'failure' ? resolve(false) : reject(new Error('Network unavailable'))
          })
      )
      start()
      fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
      expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
      expect(state.renew).toHaveBeenCalledTimes(1)
      await act(async () => {
        state.failed.forEach((callback) => callback())
        finish()
      })
      expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(screen.getByTestId('expiry')).toHaveTextContent('0')
    }
  )

  it('closes the warning on a confirmed SDK renewal event', () => {
    start()
    expect(screen.getByTestId('expiry')).toHaveTextContent('120')
    act(() => {
      state.expiresAt += 300_000
      state.renewed.forEach((callback) => callback())
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
  })

  it('keeps the warning during a pending extension and after failure', async () => {
    let resolve!: (success: boolean) => void
    state.renew.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    start()
    fireEvent.click(screen.getByRole('button', { name: 'extend' }))
    expect(state.renew).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('expiry')).toHaveTextContent('120')
    await act(async () => {
      resolve(false)
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('120')
  })

  it('closes only after an explicit extension succeeds', async () => {
    state.renew.mockResolvedValue(true)
    start()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'extend' }))
    })
    expect(state.renew).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
  })

  it('uses the actual expiry and catches up after a suspended tab resumes', async () => {
    state.expiresAt = Date.now() + 45_000
    start()
    expect(screen.getByTestId('expiry')).toHaveTextContent('45')
    vi.setSystemTime(Date.now() + 46_000)
    state.token = undefined
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('0')
  })

  it('requests renewal on focus and a visible periodic check', async () => {
    start()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(state.renew).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(state.renew).toHaveBeenCalledTimes(2)
  })

  it('does not reset the deadline on repeated expiry signals or renew while hidden', async () => {
    start()
    vi.setSystemTime(Date.now() + 20_000)
    act(() => {
      state.expiring.forEach((callback) => callback())
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('100')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(state.renew).not.toHaveBeenCalled()
    expect(screen.getByTestId('expiry')).toHaveTextContent('40')
  })

  it('opens truthful expired state after a failed renewal without a live token', () => {
    start()
    act(() => {
      state.token = undefined
      state.failed.forEach((callback) => callback())
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('0')
  })

  it('ignores an in-flight extension and old callbacks after logout', async () => {
    let resolve!: (success: boolean) => void
    state.renew.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    start()
    const oldFailed = [...state.failed]
    fireEvent.click(screen.getByRole('button', { name: 'extend' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'logout' }))
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
    await act(async () => {
      resolve(false)
      oldFailed.forEach((callback) => callback())
    })
    expect(screen.getByTestId('expiry')).toHaveTextContent('closed')
  })
})

function ReconnectProbe() {
  const session = useSessionExpiryDialog()
  return <button onClick={session.signInAgain}>reconnect</button>
}
it('saves through the shared seam before the actual provider starts replacement authentication', () => {
  const calls: string[] = []
  const unregister = onBeforeSignIn(() => calls.push('save'))
  vi.mocked(authAdapter.signIn).mockImplementation(async () => {
    calls.push('redirect')
  })
  render(
    <AuthProvider>
      <SessionExpiryProvider>
        <ReconnectProbe />
      </SessionExpiryProvider>
    </AuthProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'reconnect' }))
  unregister()
  expect(calls).toEqual(['save', 'redirect'])
})

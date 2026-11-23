import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthLifetime } from '../../auth/authLifetimeContext'
import { coreApi } from '../../api/client'
import { useForegroundPresence } from './useForegroundPresence'

vi.mock('../../api/client', () => ({ coreApi: vi.fn() }))
beforeEach(() => vi.stubEnv('MODE', 'development'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('renews visible active membership leases and revokes on hide, switch, sign-out and unmount', async () => {
  vi.useFakeTimers()
  let visible = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visible as DocumentVisibilityState
  )
  const put = vi.fn(async () => ({}))
  const remove = vi.fn(async () => ({}))
  vi.mocked(coreApi).mockReturnValue({ PUT: put, DELETE: remove } as unknown as ReturnType<
    typeof coreApi
  >)
  let usable = true
  const listeners = new Set<() => void>()
  const lifetime = {
    hasUsableCredential: () => usable,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as AuthLifetime
  const { rerender, unmount } = renderHook(
    ({ org, active }) => useForegroundPresence(org, active, lifetime),
    {
      initialProps: { org: 'first', active: true },
    }
  )
  await act(async () => {})
  expect(put).toHaveBeenCalledOnce()
  expect(put.mock.calls[0]).toMatchObject([
    '/notifications/presence/{device_id}',
    {
      params: { path: { device_id: expect.any(String) } },
      body: { platform: 'web' },
      signal: expect.any(AbortSignal),
    },
  ])
  await act(async () => {
    vi.advanceTimersByTime(30_000)
  })
  expect(put).toHaveBeenCalledTimes(2)
  await act(async () => {
    visible = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(remove).toHaveBeenCalledOnce()
  const count = put.mock.calls.length
  await act(async () => {
    vi.advanceTimersByTime(120_000)
  })
  expect(put).toHaveBeenCalledTimes(count)
  await act(async () => {
    visible = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  })
  rerender({ org: 'second', active: true })
  await act(async () => {})
  expect(remove).toHaveBeenCalledTimes(2)
  await act(async () => {
    usable = false
    for (const listener of listeners) listener()
  })
  expect(remove).toHaveBeenCalledTimes(3)
  await act(async () => {
    vi.advanceTimersByTime(120_000)
  })
  unmount()
  expect(listeners.size).toBe(0)
})
it('skips offline and standalone environments and publishes desktop leases in Tauri', async () => {
  const put = vi.fn(async () => ({}))
  const remove = vi.fn(async () => ({}))
  vi.mocked(coreApi).mockReturnValue({ PUT: put, DELETE: remove } as unknown as ReturnType<
    typeof coreApi
  >)
  const lifetime = {
    hasUsableCredential: () => true,
    subscribe: () => () => {},
  } as unknown as AuthLifetime
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const { unmount } = renderHook(() => useForegroundPresence('org', true, lifetime))
  expect(put).not.toHaveBeenCalled()
  unmount()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const desktop = renderHook(() => useForegroundPresence('org', true, lifetime))
  await act(async () => {})
  expect(put.mock.calls[0]).toMatchObject([expect.any(String), { body: { platform: 'desktop' } }])
  desktop.unmount()
})

it('aborts pending renewals before revoking the old organisation lease', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let finish!: () => void
  const put = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue({})
  const remove = vi.fn(async () => ({}))
  vi.mocked(coreApi).mockReturnValue({ PUT: put, DELETE: remove } as unknown as ReturnType<
    typeof coreApi
  >)
  const lifetime = {
    hasUsableCredential: () => true,
    subscribe: () => () => {},
  } as unknown as AuthLifetime
  const { rerender, unmount } = renderHook(
    ({ org, active }) => useForegroundPresence(org, active, lifetime),
    {
      initialProps: { org: 'first', active: true },
    }
  )
  const first = put.mock.calls[0]![1] as {
    signal: AbortSignal
    params: { path: { device_id: string } }
  }
  rerender({ org: 'second', active: true })
  expect(first.signal.aborted).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  await act(async () => {
    finish()
  })
  expect(remove.mock.calls[0]).toMatchObject([expect.any(String), { params: first.params }])
  rerender({ org: 'second', active: false })
  await act(async () => {})
  expect(remove).toHaveBeenCalledTimes(2)
  unmount()
  expect(remove).toHaveBeenCalledTimes(2)
})

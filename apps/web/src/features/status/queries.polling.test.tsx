import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@/api/schema'
import { createQueryClient } from '@/app/providers'
import { tenantStatusBody, TENANT_ID } from '@/mocks/overlays/support/status-fixtures'
import { useTenantStatus } from './queries'

type StatusBody = components['schemas']['TenantStatusView']
type StatusInit = { params: { path: { tenant_id: string } } }

const slot = vi.hoisted(() => ({ current: undefined as PollingFixture | undefined }))

vi.mock('@/api/client', () => ({
  coreApi: () => ({
    GET: (path: string, init: StatusInit) => {
      const fixture = slot.current
      if (!fixture) throw new Error('STATUS_FIXTURE_MISSING')
      return fixture.request(path, init)
    },
  }),
}))

const statusPath = '/tenants/{tenant_id}/status'

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

class PollingFixture {
  readonly client = createQueryClient()
  readonly calls: Array<{ path: string; tenant: string; at: number }> = []
  readonly failure = new Error('STATUS_SYNTHETIC_UNAVAILABLE')
  body: StatusBody
  failuresRemaining = 0
  private unmountHook: (() => void) | undefined

  constructor(
    readonly tenant: string | undefined,
    status: 'active' | 'provisioning'
  ) {
    this.body = tenantStatusBody({ status })
  }

  request(path: string, init: StatusInit): Promise<{ data: StatusBody }> {
    // Recorded first: an assertion thrown here would only become a swallowed query error.
    this.calls.push({ path, tenant: init.params.path.tenant_id, at: Date.now() })
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      return Promise.reject(this.failure)
    }
    return Promise.resolve({ data: this.body })
  }

  mount(): void {
    expect(this.client.getDefaultOptions().queries?.retry, 'STATUS_REAL_RETRY').toBe(2)
    expect(this.client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
    const Wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={this.client}>{children}</QueryClientProvider>
    )
    const view = renderHook(() => useTenantStatus(this.tenant), { wrapper: Wrapper })
    this.unmountHook = view.unmount
  }

  unmount(): void {
    const unmount = this.unmountHook
    this.unmountHook = undefined
    unmount?.()
  }

  state() {
    const state = this.client.getQueryState<StatusBody, Error>(['tenant-status', this.tenant])
    if (!state) throw new Error('STATUS_QUERY_MISSING')
    return state
  }

  async settled(status: 'success' | 'error' = 'success'): Promise<void> {
    await flush()
    expect(this.state().fetchStatus, 'STATUS_FETCH_SETTLED').toBe('idle')
    expect(this.state().status, 'STATUS_QUERY_SETTLED').toBe(status)
    if (status === 'success') expect(this.state().data).toEqual(this.body)
  }

  async advance(milliseconds: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds)
    })
    await flush()
  }

  async visibility(state: 'visible' | 'hidden'): Promise<void> {
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
      window.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    await flush()
    expect(focusManager.isFocused(), 'STATUS_REAL_VISIBILITY').toBe(state === 'visible')
  }
}

/** Mounts the real hook on the real query client under fake timers, then restores everything. */
async function withPolling(
  tenant: string | undefined,
  status: 'active' | 'provisioning',
  work: (fixture: PollingFixture) => Promise<void>
): Promise<void> {
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  const online = onlineManager.isOnline()
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(0)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  const fixture = new PollingFixture(tenant, status)
  slot.current = fixture
  try {
    fixture.mount()
    await work(fixture)
    for (const call of fixture.calls) {
      expect(call.path, 'STATUS_FIXED_PATH').toBe(statusPath)
      expect(call.tenant, 'STATUS_FIXED_TENANT').toBe(TENANT_ID)
    }
  } finally {
    fixture.unmount()
    await fixture.client.cancelQueries()
    fixture.client.clear()
    slot.current = undefined
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else Reflect.deleteProperty(document, 'visibilityState')
    focusManager.setFocused(undefined)
    onlineManager.setOnline(online)
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

describe('actual mounted Status polling contract', () => {
  it('S01 never requests status before a tenant exists', async () => {
    await withPolling(undefined, 'active', async (fixture) => {
      await fixture.advance(60000)
      expect(fixture.calls, 'STATUS_DISABLED_GET').toEqual([])
      expect(fixture.state().status).toBe('pending')
      expect(fixture.state().fetchStatus).toBe('idle')
      expect(fixture.state().fetchFailureCount).toBe(0)
    })
  })

  it('S02 active cadence reaches the actual GET exactly at thirty seconds', async () => {
    await withPolling(TENANT_ID, 'active', async (fixture) => {
      await fixture.settled()
      expect(fixture.calls.length).toBe(1)
      await fixture.advance(29999)
      expect(fixture.calls.length, 'STATUS_ACTIVE_EARLY_GET').toBe(1)
      await fixture.advance(1)
      expect(fixture.calls.length, 'STATUS_ACTIVE_DUE_GET').toBe(2)
      expect(fixture.calls[1]?.at).toBe(30000)
      await fixture.settled()
    })
  })

  it('S03 provisioning cadence reaches the actual GET exactly at ten seconds', async () => {
    await withPolling(TENANT_ID, 'provisioning', async (fixture) => {
      await fixture.settled()
      expect(fixture.calls.length).toBe(1)
      await fixture.advance(9999)
      expect(fixture.calls.length, 'STATUS_SETUP_EARLY_GET').toBe(1)
      await fixture.advance(1)
      expect(fixture.calls.length, 'STATUS_SETUP_DUE_GET').toBe(2)
      expect(fixture.calls[1]?.at).toBe(10000)
      await fixture.settled()
    })
  })

  it('S04 suppresses hidden GETs and refetches immediately through real visibility events', async () => {
    await withPolling(TENANT_ID, 'active', async (fixture) => {
      await fixture.settled()
      expect(fixture.calls.length, 'STATUS_INITIAL_GET').toBe(1)
      expect(fixture.calls[0]?.at).toBe(0)
      await fixture.visibility('hidden')
      await fixture.advance(60000)
      expect(fixture.calls.length, 'STATUS_HIDDEN_GET').toBe(1)
      fixture.body = tenantStatusBody({ status: 'provisioning' })
      const beforeResume = Date.now()
      await fixture.visibility('visible')
      expect(fixture.calls.length, 'STATUS_RESUME_GET').toBe(2)
      expect(Date.now()).toBe(beforeResume)
      await fixture.settled()
      expect(fixture.state().data?.status).toBe('provisioning')
    })
  })

  it('S05 preserves real retry=2 then backs off and restores normal polling after recovery', async () => {
    await withPolling(TENANT_ID, 'active', async (fixture) => {
      await fixture.settled()
      fixture.failuresRemaining = 3
      await fixture.advance(30000)
      expect(fixture.calls.length).toBe(2)
      expect(fixture.state().fetchFailureCount).toBe(1)
      await fixture.advance(999)
      expect(fixture.calls.length).toBe(2)
      await fixture.advance(1)
      expect(fixture.calls.length).toBe(3)
      expect(fixture.state().fetchFailureCount).toBe(2)
      await fixture.advance(1999)
      expect(fixture.calls.length).toBe(3)
      await fixture.advance(1)
      expect(fixture.calls.length).toBe(4)
      await fixture.settled('error')
      expect(fixture.state().fetchFailureCount, 'STATUS_REAL_THIRD_FAILURE').toBe(3)
      expect(fixture.state().error).toBe(fixture.failure)
      expect(fixture.state().data).toEqual(fixture.body)
      expect(Date.now()).toBe(33000)
      await fixture.advance(119999)
      expect(fixture.calls.length, 'STATUS_BACKOFF_EARLY_GET').toBe(4)
      await fixture.advance(1)
      expect(fixture.calls.length, 'STATUS_BACKOFF_DUE_GET').toBe(5)
      expect(fixture.calls[4]?.at).toBe(153000)
      await fixture.settled()
      expect(fixture.state().fetchFailureCount).toBe(0)
      await fixture.advance(29999)
      expect(fixture.calls.length).toBe(5)
      await fixture.advance(1)
      expect(fixture.calls.length, 'STATUS_RECOVERED_CADENCE').toBe(6)
      await fixture.settled()
    })
  })

  it('S06 removes the actual observer before subsequent intervals and focus events', async () => {
    await withPolling(TENANT_ID, 'active', async (fixture) => {
      await fixture.settled()
      expect(fixture.calls.length).toBe(1)
      fixture.unmount()
      expect(
        fixture.client
          .getQueryCache()
          .find({ queryKey: ['tenant-status', TENANT_ID] })
          ?.getObserversCount()
      ).toBe(0)
      await fixture.advance(60000)
      await fixture.visibility('hidden')
      await fixture.visibility('visible')
      expect(fixture.calls.length, 'STATUS_DISPOSED_GET').toBe(1)
    })
  })
})

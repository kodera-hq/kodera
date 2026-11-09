import { afterEach, describe, expect, it } from 'vitest'
import {
  shouldPollTenantStatus,
  statusSummaryRefetchInterval,
  tenantStatusRefetchInterval,
} from './polling'

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

afterEach(() => {
  setHidden(false)
})

describe('statusSummaryRefetchInterval', () => {
  it('polls every 60 s while healthy and the tab is visible', () => {
    expect(statusSummaryRefetchInterval(0)).toBe(60_000)
  })

  it('backs off to 5 minutes after three consecutive failures', () => {
    expect(statusSummaryRefetchInterval(2)).toBe(60_000)
    expect(statusSummaryRefetchInterval(3)).toBe(300_000)
    expect(statusSummaryRefetchInterval(9)).toBe(300_000)
  })

  it('never polls while the tab is hidden, healthy or not', () => {
    setHidden(true)
    expect(statusSummaryRefetchInterval(0)).toBe(false)
    expect(statusSummaryRefetchInterval(5)).toBe(false)
  })
})

describe('tenantStatusRefetchInterval', () => {
  it('polls every 10 s while healthy and the tab is visible', () => {
    expect(tenantStatusRefetchInterval(0)).toBe(10_000)
  })

  it('backs off to 5 minutes after three consecutive failures', () => {
    expect(tenantStatusRefetchInterval(3)).toBe(300_000)
  })

  it('never polls while the tab is hidden', () => {
    setHidden(true)
    expect(tenantStatusRefetchInterval(0)).toBe(false)
  })
})

describe('shouldPollTenantStatus', () => {
  it('is false when there is no tenant at all', () => {
    expect(shouldPollTenantStatus(undefined)).toBe(false)
  })

  it('is true while the tenant has not yet reached active', () => {
    expect(shouldPollTenantStatus('provisioning')).toBe(true)
    expect(shouldPollTenantStatus('ordered')).toBe(true)
  })

  it('is false once the tenant is active — Home reads the summary instead', () => {
    expect(shouldPollTenantStatus('active')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { statusPollingIntervalMs } from './polling'

describe('statusPollingIntervalMs', () => {
  it('polls every 30s for an active tenant with no failures', () => {
    expect(statusPollingIntervalMs('active', 0)).toBe(30_000)
  })

  it('polls every 10s for a provisioning tenant with no failures', () => {
    expect(statusPollingIntervalMs('provisioning', 0)).toBe(10_000)
  })

  it('defaults to the 30s interval before the first status is known', () => {
    expect(statusPollingIntervalMs(undefined, 0)).toBe(30_000)
  })

  it('backs off to 2 minutes after three consecutive failures, even while provisioning', () => {
    expect(statusPollingIntervalMs('provisioning', 3)).toBe(120_000)
  })

  it('backs off to 2 minutes after three consecutive failures for an active tenant', () => {
    expect(statusPollingIntervalMs('active', 3)).toBe(120_000)
  })

  it('does not back off before the third failure', () => {
    expect(statusPollingIntervalMs('active', 2)).toBe(30_000)
  })
})

it.each(['ordered', 'ready'])('polls pending setup %s at ten seconds', (status) => {
  expect(statusPollingIntervalMs(status as 'provisioning', 0)).toBe(10_000)
})
it('stops only terminal deleted polling', () => {
  expect(statusPollingIntervalMs('deleted' as 'active', 0)).toBe(false)
})
it.each([
  'maintenance',
  'upgrading',
  'suspended',
  'decommissioning',
  'failed',
  'unknown',
  'toString',
])('keeps %s polling and failure backoff', (status) => {
  expect(statusPollingIntervalMs(status as 'active', 0)).toBe(30_000)
  expect(statusPollingIntervalMs(status as 'active', 3)).toBe(120_000)
})

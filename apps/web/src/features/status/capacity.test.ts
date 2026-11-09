import { describe, expect, it } from 'vitest'
import { capacityTier, hasCapacityLimit } from './capacity'

describe('capacityTier', () => {
  it('is normal below the server-given threshold', () => {
    expect(capacityTier(34, 90)).toBe('normal')
  })

  it('is warning at and above the server-given threshold', () => {
    expect(capacityTier(92, 90)).toBe('warning')
  })

  it('is full at 100%, whatever the threshold is', () => {
    expect(capacityTier(100, 90)).toBe('full')
  })

  it('reads the threshold from its argument, never a constant', () => {
    // A tenant whose plan sets a different threshold (e.g. 80) still warns
    // correctly — this only ever compares against what it is given.
    expect(capacityTier(85, 80)).toBe('warning')
    expect(capacityTier(85, 90)).toBe('normal')
  })
})

describe('hasCapacityLimit', () => {
  it('is true when included is positive', () => {
    expect(hasCapacityLimit({ used: 10, included: 50, pct: 20 })).toBe(true)
  })

  it('is false when included is zero', () => {
    expect(hasCapacityLimit({ used: 0, included: 0, pct: 0 })).toBe(false)
  })
})

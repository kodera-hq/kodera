import { describe, expect, it } from 'vitest'
import { headcountRangeFor, largestCoveredHeadcount, recommendTier } from './recommendation'

// 01-order.md §6: "the peak is about 30% of the headcount, and the
// recommendation is the first tier whose included concurrent participants
// covers that peak — rounded up, never down." This is the one arithmetic the
// console is allowed to do, so it is the one thing this unit tests hardest.

const TIERS = [
  { code: 'S', concurrent_participants_included: 24 },
  { code: 'M', concurrent_participants_included: 50 },
  { code: 'L', concurrent_participants_included: 100 },
]

describe('recommendTier', () => {
  it('recommends the smallest tier whose peak capacity covers 30% of the headcount', () => {
    // 120 people -> peak = ceil(120 * 0.3) = 36, which exceeds S (24) but fits M (50).
    expect(recommendTier(120, TIERS)?.code).toBe('M')
  })

  it('rounds the peak up, never down', () => {
    // 79 people -> peak = ceil(23.7) = 24, which exactly fits S (24).
    expect(recommendTier(79, TIERS)?.code).toBe('S')
    // 80 people -> peak = ceil(24) = 24, still exactly fits S.
    expect(recommendTier(80, TIERS)?.code).toBe('S')
    // 81 people -> peak = ceil(24.3) = 25, which no longer fits S (24).
    expect(recommendTier(81, TIERS)?.code).toBe('M')
  })

  // 01-order.md §1: the recommendation is the first tier that COVERS the peak.
  // 340 people -> peak = ceil(102) = 102, over L's 100: no tier covers it, and
  // falling back to the largest one recommended a tier the page itself said
  // was too small ("Plus de 330 personnes ? Parlons-en.").
  it('recommends no tier when the peak exceeds every tier', () => {
    expect(recommendTier(340, TIERS)).toBeUndefined()
    expect(recommendTier(2000, TIERS)).toBeUndefined()
  })

  it('still recommends the largest tier up to its last covered headcount', () => {
    // 333 people -> peak = ceil(99.9) = 100, exactly L's capacity.
    expect(recommendTier(333, TIERS)?.code).toBe('L')
    // 334 people -> peak = ceil(100.2) = 101.
    expect(recommendTier(334, TIERS)).toBeUndefined()
  })

  it('returns undefined for an empty catalogue', () => {
    expect(recommendTier(120, [])).toBeUndefined()
  })

  it('ignores unavailable tiers', () => {
    const withUnavailable = [
      { code: 'S', concurrent_participants_included: 24, available: false },
      { code: 'M', concurrent_participants_included: 50, available: true },
    ]
    expect(recommendTier(10, withUnavailable)?.code).toBe('M')
  })
})

describe('headcountRangeFor', () => {
  it('derives the headcount range a tier is designed for, from the same 30% rule', () => {
    // S covers a peak up to 24 -> headcount up to floor(24 / 0.3) = 80.
    expect(headcountRangeFor(TIERS[1]!, TIERS)).toEqual({ min: 81, max: 166 })
  })

  it('starts the first tier at 1 person', () => {
    expect(headcountRangeFor(TIERS[0]!, TIERS)).toEqual({ min: 1, max: 80 })
  })

  it('bounds the top tier like every other one', () => {
    // L covers a peak up to 100 -> headcount up to floor(100 / 0.3) = 333.
    expect(headcountRangeFor(TIERS[2]!, TIERS)).toEqual({ min: 167, max: 333 })
  })
})

describe('largestCoveredHeadcount', () => {
  it('is the top of the largest tier range, the one cutoff every sentence names', () => {
    expect(largestCoveredHeadcount(TIERS)).toBe(333)
    expect(recommendTier(largestCoveredHeadcount(TIERS)!, TIERS)?.code).toBe('L')
    expect(recommendTier(largestCoveredHeadcount(TIERS)! + 1, TIERS)).toBeUndefined()
  })

  it('is undefined for an empty catalogue', () => {
    expect(largestCoveredHeadcount([])).toBeUndefined()
  })
})

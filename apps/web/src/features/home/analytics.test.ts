import { describe, expect, it } from 'vitest'
import { capacityBucket, invitationsBucket } from './analytics'

describe('capacityBucket', () => {
  it('buckets under the 90 % threshold', () => {
    expect(capacityBucket(62)).toBe('under-90')
    expect(capacityBucket(89.9)).toBe('under-90')
  })

  it('buckets from 90 up to (not including) 100', () => {
    expect(capacityBucket(90)).toBe('90-99')
    expect(capacityBucket(92)).toBe('90-99')
    expect(capacityBucket(99.9)).toBe('90-99')
  })

  it('buckets 100 and above as at-limit', () => {
    expect(capacityBucket(100)).toBe('at-limit')
  })
})

describe('invitationsBucket', () => {
  it('buckets 1 to 4 pending invitations', () => {
    expect(invitationsBucket(1)).toBe('1-4')
    expect(invitationsBucket(4)).toBe('1-4')
  })

  it('buckets 5 to 19 pending invitations', () => {
    expect(invitationsBucket(5)).toBe('5-19')
    expect(invitationsBucket(19)).toBe('5-19')
  })

  it('buckets 20 and above as 20+', () => {
    expect(invitationsBucket(20)).toBe('20+')
  })
})

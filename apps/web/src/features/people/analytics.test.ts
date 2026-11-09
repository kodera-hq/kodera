import { afterEach, describe, expect, it } from 'vitest'
import { onTrack, type AnalyticsEvent } from '@/analytics/track'
import {
  memberCountBucket,
  trackInviteResult,
  trackInviteSubmitted,
  trackPeopleViewed,
  trackRoleChanged,
} from './analytics'

let stop: (() => void) | undefined
afterEach(() => stop?.())

function record(): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = []
  stop = onTrack((event) => events.push(event))
  return events
}

describe('People analytics (03-people.md §11)', () => {
  it('sends counts and codes only, never an address', () => {
    const events = record()
    trackInviteSubmitted(3, 'org_member', true)
    trackInviteResult(2, 2, ['invalid_email', 'already_member'])
    expect(events).toEqual([
      {
        name: 'people_invite_submitted',
        properties: { count: 3, role: 'org_member', paste_used: true },
      },
      {
        name: 'people_invite_result',
        properties: { sent: 2, rejected: 2, reasons: 'already_member,invalid_email' },
      },
    ])
  })

  it('buckets the member count rather than sending it', () => {
    expect(memberCountBucket(1)).toBe('1')
    expect(memberCountBucket(18)).toBe('11-50')
    expect(memberCountBucket(118)).toBe('51-200')
    expect(memberCountBucket(900)).toBe('>200')
    const events = record()
    trackPeopleViewed('members', 118)
    trackRoleChanged('org_member', 'org_admin')
    expect(events.map((e) => e.properties)).toEqual([
      { tab: 'members', member_count_bucket: '51-200' },
      { from: 'org_member', to: 'org_admin' },
    ])
  })
})

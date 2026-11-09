import { describe, expect, it } from 'vitest'
import { invitationsPastTheirSetUpLink, summariseResend } from './invitations'
import type { ResendOutcome } from './invitations'
import type { components } from '../../api/schema'

type Invitation = components['schemas']['Invitation']

const NOW = new Date('2026-09-02T12:00:00Z')

function invitation(overrides: Partial<Invitation>): Invitation {
  return {
    id: 'inv-1',
    organisation_id: 'org-1',
    email: 'marc@acme.fr',
    role: 'org_member',
    state: 'pending',
    expires_at: '2026-09-09T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

describe('invitationsPastTheirSetUpLink', () => {
  // The realm's set-up link lives 72 hours (Core's ACTIONS_LIFESPAN_S); NOW minus 72 h is 08-30 12:00.
  it('keeps an invitation created just more than 72 hours before now', () => {
    const old = invitation({ created_at: '2026-08-30T11:59:59Z' })
    expect(invitationsPastTheirSetUpLink([old], NOW)).toEqual([old])
  })

  it('excludes an invitation created within the last 72 hours', () => {
    const fresh = invitation({ created_at: '2026-08-31T00:00:00Z' })
    expect(invitationsPastTheirSetUpLink([fresh], NOW)).toEqual([])
  })

  it('excludes an invitation created exactly 72 hours ago', () => {
    const exact = invitation({ created_at: '2026-08-30T12:00:00Z' })
    expect(invitationsPastTheirSetUpLink([exact], NOW)).toEqual([])
  })

  it('counts from the last send, since a resend mails a fresh set-up link', () => {
    const resent = invitation({
      created_at: '2026-08-28T12:00:00Z',
      last_sent_at: '2026-09-02T11:00:00Z',
    })
    const resentLongAgo = invitation({
      id: 'inv-2',
      created_at: '2026-08-28T12:00:00Z',
      last_sent_at: '2026-08-29T12:00:00Z',
    })
    const neverResent = invitation({
      id: 'inv-3',
      created_at: '2026-08-28T12:00:00Z',
      last_sent_at: null,
    })
    expect(invitationsPastTheirSetUpLink([resent, resentLongAgo, neverResent], NOW)).toEqual([
      resentLongAgo,
      neverResent,
    ])
  })

  it('returns an empty list when there is nothing to page', () => {
    expect(invitationsPastTheirSetUpLink([], NOW)).toEqual([])
  })
})

describe('summariseResend', () => {
  it('counts every outcome as attempted, splitting succeeded from failed', () => {
    const outcomes: ResendOutcome[] = [
      { invitation: invitation({ id: 'a' }), ok: true },
      { invitation: invitation({ id: 'b' }), ok: true },
      { invitation: invitation({ id: 'c' }), ok: false, retryAfterS: 30 },
    ]
    const summary = summariseResend(outcomes)
    expect(summary.attempted).toBe(3)
    expect(summary.succeeded).toBe(2)
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0]?.invitation.id).toBe('c')
    expect(summary.failed[0]?.retryAfterS).toBe(30)
  })

  it('reports every success and no failure when the whole batch succeeds', () => {
    const outcomes: ResendOutcome[] = [
      { invitation: invitation({ id: 'a' }), ok: true },
      { invitation: invitation({ id: 'b' }), ok: true },
    ]
    const summary = summariseResend(outcomes)
    expect(summary.succeeded).toBe(2)
    expect(summary.failed).toEqual([])
  })

  it('reports every failure and no success when the whole batch fails', () => {
    const outcomes: ResendOutcome[] = [{ invitation: invitation({ id: 'a' }), ok: false }]
    const summary = summariseResend(outcomes)
    expect(summary.succeeded).toBe(0)
    expect(summary.failed).toHaveLength(1)
  })
})

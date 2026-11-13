import { describe, expect, it, vi } from 'vitest'
import { ApiProblem } from '../../../api/client'
import { expiryIn, inviteUrl, ReportAlreadyDecided, resolveReport } from './moderationApi'

const ORG = crypto.randomUUID()
const REPORT = crypto.randomUUID()

function stale(current: string) {
  return new ApiProblem({ status: 412, type: 'precondition-failed', currentEtag: current } as never)
}

const report = (status: 'open' | 'resolved') => ({
  id: REPORT,
  membershipId: crypto.randomUUID(),
  reason: 'spam',
  status,
  resolution: null,
  createdAt: '2026-11-12T08:00:00Z',
})

describe('an invite link', () => {
  it('carries its code in the fragment only', () => {
    const url = new URL(inviteUrl('code with/slash', 'https://console.exemple.fr'))
    expect(url.search).toBe('')
    expect(url.hash).toBe('#code%20with%2Fslash')
    expect(url.pathname.endsWith('/join')).toBe(true)
  })

  it('expires between one and thirty days from now', () => {
    const now = new Date('2026-11-12T00:00:00Z')
    expect(expiryIn(0, now)).toBe('2026-11-13T00:00:00.000Z')
    expect(expiryIn(90, now)).toBe('2026-12-12T00:00:00.000Z')
  })
})

describe('deciding a report', () => {
  it('re-reads the report on a stale version and decides it while it is still open', async () => {
    const tag = `"${crypto.randomUUID()}"`
    const patch = vi
      .fn()
      .mockRejectedValueOnce(stale(tag))
      .mockResolvedValueOnce({ ...report('resolved') })
    const list = vi.fn().mockResolvedValue([report('open')])
    await resolveReport(ORG, REPORT, 'resolved', 'Message retiré', { patch, list })
    expect(patch).toHaveBeenLastCalledWith(
      ORG,
      REPORT,
      { status: 'resolved', resolution: 'Message retiré' },
      tag
    )
  })

  it('never overwrites a decision another moderator made meanwhile', async () => {
    const patch = vi.fn().mockRejectedValueOnce(stale('"x"'))
    const list = vi.fn().mockResolvedValue([report('resolved')])
    await expect(
      resolveReport(ORG, REPORT, 'dismissed', 'Non fondé', { patch, list })
    ).rejects.toThrow(ReportAlreadyDecided)
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('passes any other refusal through untouched', async () => {
    const forbidden = new ApiProblem({ status: 403, type: 'forbidden' } as never)
    const patch = vi.fn().mockRejectedValueOnce(forbidden)
    await expect(
      resolveReport(ORG, REPORT, 'resolved', 'x', { patch, list: vi.fn() })
    ).rejects.toBe(forbidden)
  })
})

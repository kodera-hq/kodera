import { describe, expect, it } from 'vitest'
import { supportHref } from './support'

describe('supportHref', () => {
  it('carries the reason as a query parameter', () => {
    expect(supportHref('acme-sa', 'stale')).toBe('/acme-sa/help?reason=stale')
  })

  it('carries a job reference when one is given, for a failed provisioning step', () => {
    expect(supportHref('acme-sa', 'step-failed', 'job-42')).toBe(
      '/acme-sa/help?reason=step-failed&job_id=job-42'
    )
  })

  it('omits job_id entirely when none is given', () => {
    expect(supportHref('acme-sa', 'incident')).not.toContain('job_id')
  })
})

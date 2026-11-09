import { describe, expect, it } from 'vitest'
import { announcedTitleKey, contentTitleKey } from './contentTitle'

describe('contextual page title', () => {
  it('keeps the billing area on nested invoice routes', () => {
    expect(contentTitleKey('/acme-sa/invoices/invoice-1', 'org_billing')).toBe(
      'console.shell.nav.title-invoices'
    )
  })
  it('uses the shared application destination', () => {
    expect(contentTitleKey('/acme-sa/status', 'org_member')).toBe('console.shell.nav.title-apps')
  })
  it('names account places independently of the organisation role', () => {
    expect(contentTitleKey('/acme-sa/appearance', 'org_member')).toBe(
      'console.shell.account.action-appearance'
    )
    expect(contentTitleKey('/acme-sa/security/mfa', 'org_member')).toBe(
      'console.shell.account.action-security'
    )
  })
  it('does not describe an unavailable or unknown destination as accessible', () => {
    expect(contentTitleKey('/acme-sa/people', 'org_member')).toBe(
      'console.shell.rail.title-console'
    )
    expect(contentTitleKey('/acme-sa/unknown', 'org_owner')).toBe(
      'console.shell.rail.title-console'
    )
  })
})

describe('the title a route change announces', () => {
  it('is the title the content header shows', () => {
    for (const [pathname, role] of [
      ['/acme-sa/home', 'org_owner'],
      ['/acme-sa/invoices/invoice-1', 'org_billing'],
      ['/acme-sa/security/mfa', 'org_member'],
      ['/acme-sa/people', 'org_member'],
      ['/acme-sa/federation', 'org_owner'],
    ] as const) {
      expect(announcedTitleKey(pathname, role)).toBe(contentTitleKey(pathname, role))
    }
  })
  it('names the order flow, where the header only has its fallback', () => {
    expect(contentTitleKey('/acme-sa/order/draft-1/plan', 'org_owner')).toBe(
      'console.shell.rail.title-console'
    )
    expect(announcedTitleKey('/acme-sa/order/draft-1/plan', 'org_owner')).toBe(
      'console.order._.title'
    )
    expect(announcedTitleKey('/acme-sa/order', 'org_owner')).toBe('console.order._.title')
  })
})

import { describe, expect, it } from 'vitest'
import { appStatusTone, billingPeriodKey, firstNameOf } from './format-helpers'

describe('firstNameOf', () => {
  it('takes the first word of a full display name', () => {
    expect(firstNameOf({ display_name: 'Claire Dubois', email: 'claire@acme.fr' })).toBe('Claire')
  })

  it('falls back to the email local part when there is no display name', () => {
    expect(firstNameOf({ email: 'claire@acme.fr' })).toBe('claire')
  })

  it('falls back to the email local part when the display name is blank', () => {
    expect(firstNameOf({ display_name: '   ', email: 'claire@acme.fr' })).toBe('claire')
  })

  it('handles a single-word display name', () => {
    expect(firstNameOf({ display_name: 'Claire', email: 'claire@acme.fr' })).toBe('Claire')
  })
})

describe('appStatusTone', () => {
  it('reads a live app as success', () => {
    expect(appStatusTone('live')).toBe('success')
  })

  it('reads a degraded app as warning', () => {
    expect(appStatusTone('degraded')).toBe('warning')
  })

  it('reads an unavailable app as danger', () => {
    expect(appStatusTone('unavailable')).toBe('danger')
  })

  it('reads maintenance and pending as neutral, never as operational', () => {
    expect(appStatusTone('maintenance')).toBe('neutral')
    expect(appStatusTone('pending')).toBe('neutral')
  })
})

describe('billingPeriodKey', () => {
  it('maps yearly to the yearly catalogue key', () => {
    expect(billingPeriodKey('yearly')).toBe('console.home.overview.label-billing-period-yearly')
  })

  it('maps monthly to the monthly catalogue key', () => {
    expect(billingPeriodKey('monthly')).toBe('console.home.overview.label-billing-period-monthly')
  })
})

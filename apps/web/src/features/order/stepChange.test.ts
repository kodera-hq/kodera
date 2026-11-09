// docs/specs/01-order.md §10: a step of the order wizard is announced by the
// wizard and by nothing else. The organisation layout asks this module which
// route changes are such steps.
import { describe, expect, it } from 'vitest'
import { isOrderStepChange } from './stepChange'

const at = (step: string, draft = 'draft-1', org = 'acme-sa') => `/${org}/order/${draft}/${step}`

describe('a step change inside the order wizard', () => {
  it('is a move between two of the four steps of one draft', () => {
    expect(isOrderStepChange(at('plan'), at('contacts'))).toBe(true)
    expect(isOrderStepChange(at('contacts'), at('plan'))).toBe(true)
    expect(isOrderStepChange(at('contacts'), at('agreements'))).toBe(true)
    expect(isOrderStepChange(at('agreements'), at('confirmation'))).toBe(true)
  })

  it('is not entering or leaving the order', () => {
    expect(isOrderStepChange('/acme-sa/home', at('plan'))).toBe(false)
    expect(isOrderStepChange(at('confirmation'), '/acme-sa/status')).toBe(false)
    expect(isOrderStepChange('/acme-sa/order', at('plan'))).toBe(false)
  })

  // The quote request is reached from the plan and is not one of the wizard's
  // steps: the wizard, and its region, are not on that screen to say anything.
  it('is not the way to or from the quote request', () => {
    expect(isOrderStepChange(at('plan'), at('quote'))).toBe(false)
    expect(isOrderStepChange(at('quote'), at('plan'))).toBe(false)
  })

  // Another draft, or another organisation, is another wizard: the one that
  // would have announced the step is gone.
  it('is not a move to another draft or another organisation', () => {
    expect(isOrderStepChange(at('plan', 'draft-1'), at('contacts', 'draft-2'))).toBe(false)
    expect(
      isOrderStepChange(at('plan', 'draft-1', 'acme-sa'), at('contacts', 'draft-1', 'acme-holding'))
    ).toBe(false)
  })

  it('is not an address that only resembles a step', () => {
    expect(isOrderStepChange(at('plan'), at('unknown'))).toBe(false)
    expect(isOrderStepChange(at('plan'), `${at('contacts')}/more`)).toBe(false)
    expect(
      isOrderStepChange('/acme-sa/invoices/draft-1/plan', '/acme-sa/invoices/draft-1/contacts')
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { vatRegimeSentenceKey } from './vatRegime'

describe('vatRegimeSentenceKey', () => {
  it('has no sentence for the ordinary domestic regime', () => {
    expect(vatRegimeSentenceKey('fr_standard')).toBeUndefined()
  })

  it('has no sentence when the regime is unknown', () => {
    expect(vatRegimeSentenceKey(undefined)).toBeUndefined()
  })

  it('names a catalogue key for each non-standard regime', () => {
    expect(vatRegimeSentenceKey('eu_reverse_charge')).toBe(
      'console.invoices._.vat-regime-eu-reverse-charge'
    )
    expect(vatRegimeSentenceKey('exempt')).toBe('console.invoices._.vat-regime-exempt')
    expect(vatRegimeSentenceKey('outside_eu')).toBe('console.invoices._.vat-regime-outside-eu')
  })
})

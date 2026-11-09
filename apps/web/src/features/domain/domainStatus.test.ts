import { describe, expect, it } from 'vitest'
import fr from '../../i18n/fr.json'
import { STATE_PRESENTATION, isDomainState } from './domainStatus'

describe('the state of an address', () => {
  it('has a word and a colour for every state of the contract', () => {
    const shown = Object.fromEntries(
      Object.entries(STATE_PRESENTATION).map(([state, presentation]) => [
        state,
        `${presentation.pill}: ${fr[presentation.labelKey]}`,
      ])
    )
    expect(shown).toEqual({
      pending: 'neutral: En attente de configuration',
      nonce_issued: 'neutral: En attente de configuration',
      txt_verified: 'info: Vérification en cours',
      dns_pending: 'neutral: En attente de configuration',
      certificate_issued: 'info: Vérification en cours',
      live: 'success: Vérifié',
      failed: 'danger: Échec',
    })
  })

  it('knows a contract state from anything else', () => {
    expect(isDomainState('live')).toBe(true)
    expect(isDomainState('verified')).toBe(false)
    expect(isDomainState('toString')).toBe(false)
    expect(isDomainState(null)).toBe(false)
  })
})

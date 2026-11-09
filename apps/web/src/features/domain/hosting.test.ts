import { describe, expect, it } from 'vitest'
import fr from '../../i18n/fr.json'
import {
  baseDomain,
  baseTenant,
  domainId,
  mixedAddresses,
  providedHosts,
} from '../../mocks/fixtures/domainFixtures'
import type { Domain } from '../../mocks/fixtures/domainFixtures'
import { PURPOSE_LABEL_KEY, addressRows, isAddressPurpose, providedAddresses } from './hosting'

describe('the addresses provided with an instance', () => {
  it('are the hosts the API reports, in its order, under the keys it files them by', () => {
    const tenant = baseTenant()
    const addresses = providedAddresses(tenant)

    expect(addresses.map((address) => address.app)).toEqual(Object.keys(tenant.default_urls ?? {}))
    expect(addresses.map((address) => address.host)).toEqual(providedHosts(tenant))
    // The fixture really has some: two empty lists would agree about nothing.
    expect(addresses.length).toBeGreaterThanOrEqual(2)
    for (const address of addresses) {
      expect(address.host).not.toContain('/')
      expect(address.host).not.toContain(':')
    }
  })

  it('follow the API when it names other hosts', () => {
    const addresses = providedAddresses({
      default_urls: {
        visio: 'https://reunions.exemple.test',
        docs: 'https://documents.exemple.test:8443/accueil',
      },
    })
    expect(addresses).toEqual([
      { app: 'visio', host: 'reunions.exemple.test' },
      { app: 'docs', host: 'documents.exemple.test:8443' },
    ])
  })

  it('are none when the instance reports none, and none is made up', () => {
    expect(providedAddresses({})).toEqual([])
    expect(providedAddresses({ default_urls: {} })).toEqual([])
  })

  it.each([
    ['a list', ['https://reunions.exemple.test']],
    ['null', null],
    ['a sentence', 'https://reunions.exemple.test'],
  ])('refuse the instance when the field is %s', (_name, value) => {
    expect(() => providedAddresses({ default_urls: value })).toThrow(
      'The provided addresses of the instance are unavailable.'
    )
  })

  it.each([
    ['a bare host', 'reunions.exemple.test'],
    ['another scheme', 'ftp://reunions.exemple.test'],
    ['a script', 'javascript:alert(1)'],
    ['a number', 443],
    ['nothing', ''],
  ])('refuse the instance when one value is %s', (_name, value) => {
    expect(() =>
      providedAddresses({ default_urls: { visio: 'https://reunions.exemple.test', docs: value } })
    ).toThrow('A provided address of the instance is unavailable.')
  })
})

describe('what an address is for', () => {
  it('needs saying only when it carries the calls', () => {
    expect(PURPOSE_LABEL_KEY.web).toBeNull()
    expect(PURPOSE_LABEL_KEY.media && fr[PURPOSE_LABEL_KEY.media]).toBe('Appels vidéo')
  })

  it('is one of the purposes of the contract', () => {
    expect(isAddressPurpose('web')).toBe(true)
    expect(isAddressPurpose('media')).toBe(true)
    expect(isAddressPurpose('mail')).toBe(false)
    expect(isAddressPurpose('valueOf')).toBe(false)
    expect(isAddressPurpose(undefined)).toBe(false)
  })
})

describe('the list of addresses', () => {
  it('reads the organisation’s own addresses first, then the provided ones', () => {
    const provided = providedAddresses(baseTenant())
    const rows = addressRows(provided, mixedAddresses())

    expect(rows.map((row) => row.origin)).toEqual([
      ...mixedAddresses().map(() => 'organisation'),
      ...provided.map(() => 'provided'),
    ])
    expect(rows.map((row) => row.host)).toEqual([
      ...mixedAddresses().map((domain) => domain.fqdn),
      ...provided.map((address) => address.host),
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })

  it('takes the state, the purpose and the main address from the API', () => {
    const [main, calls, waiting] = addressRows([], mixedAddresses())

    expect(main).toEqual({
      origin: 'organisation',
      key: domainId(1),
      host: 'visio.acme.fr',
      app: 'visio',
      purpose: 'web',
      state: 'live',
      main: true,
    })
    expect(calls).toMatchObject({ purpose: 'media', state: 'live', main: false })
    expect(waiting).toMatchObject({ app: 'docs', state: 'nonce_issued', main: false })
  })

  it('names no main address when the API names none', () => {
    const { is_canonical: _unused, ...unflagged } = baseDomain('visio.acme.fr', { state: 'live' })
    // The flag has a default in the contract, so the generated type requires it;
    // the wire may still leave it out.
    const rows = addressRows(providedAddresses(baseTenant()), [unflagged as Domain])

    expect(rows.filter((row) => row.origin === 'organisation' && row.main)).toEqual([])
    // A provided address has no state and no claim to be the main one.
    for (const row of rows.filter((entry) => entry.origin === 'provided')) {
      expect(Object.keys(row).sort()).toEqual(['app', 'host', 'key', 'origin'])
    }
  })

  it('keeps an address that serves no application', () => {
    const [row] = addressRows([], [baseDomain('acme.fr', { app: null })])
    expect(row).toMatchObject({ host: 'acme.fr', app: null })
  })
})

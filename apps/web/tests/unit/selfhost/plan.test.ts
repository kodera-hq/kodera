import { describe, expect, it } from 'vitest'
import {
  PROVIDER_API_ORIGINS,
  REDACTED_TOKEN_PREVIEW,
  SelfHostValidationError,
  safeValidateSelfHostSpec,
  validateSelfHostSpec,
} from '@/features/selfhost'

describe('validateSelfHostSpec', () => {
  it('validates all four cloud providers, maps their API origins, and redacts the token', () => {
    const rawToken = 'scw_secret_0123456789abcdef0123456789'
    const plan = validateSelfHostSpec({
      provider: 'Scaleway',
      region: 'fr-par-1',
      fqdn: 'Chat.Acme-Corp.EU',
      acmeEmail: 'ops@acme-corp.eu',
      rawToken,
    })

    expect(plan.provider).toBe('scaleway')
    expect(plan.apiOrigin).toBe('https://api.scaleway.com')
    expect(plan.region).toBe('fr-par-1')
    expect(plan.fqdn).toBe('chat.acme-corp.eu')
    expect(plan.acmeEmail).toBe('ops@acme-corp.eu')
    expect(plan.redactedTokenPreview).toBe(REDACTED_TOKEN_PREVIEW)
    expect(plan.composeEnvPreview).toEqual({
      KODERA_PUBLIC_DOMAIN: 'chat.acme-corp.eu',
      KODERA_MATRIX_HOST: 'matrix.chat.acme-corp.eu',
      KODERA_VISIO_HOST: 'visio.chat.acme-corp.eu',
      KODERA_DOCS_HOST: 'docs.chat.acme-corp.eu',
      KODERA_AUTH_HOST: 'auth.chat.acme-corp.eu',
      KODERA_ACME_EMAIL: 'ops@acme-corp.eu',
      KODERA_PROVIDER_TOKEN: '[REDACTED]',
    })

    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain(rawToken)
    expect(serialized).toContain('[REDACTED]')

    expect(plan.dnsRecords.map((r) => `${r.type}:${r.name}`)).toEqual([
      'A:chat.acme-corp.eu',
      'AAAA:chat.acme-corp.eu',
      'A:matrix.chat.acme-corp.eu',
      'AAAA:matrix.chat.acme-corp.eu',
      'A:visio.chat.acme-corp.eu',
      'AAAA:visio.chat.acme-corp.eu',
      'A:docs.chat.acme-corp.eu',
      'AAAA:docs.chat.acme-corp.eu',
      'A:auth.chat.acme-corp.eu',
      'AAAA:auth.chat.acme-corp.eu',
    ])

    expect(PROVIDER_API_ORIGINS).toEqual({
      scaleway: 'https://api.scaleway.com',
      hetzner: 'https://api.hetzner.cloud',
      hostinger: 'https://developers.hostinger.com',
      ovhcloud: 'https://eu.api.ovh.com',
    })
  })

  it('rejects localhost, internal domains, raw IP literals, and malformed labels', () => {
    const invalidDomains = [
      'localhost',
      'kodera.localhost',
      'kodera.local',
      'kodera.internal',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      '[::1]',
      'singlelabel',
      '-bad.acme.eu',
      'bad-.acme.eu',
      'acme.123',
      'a.b',
    ]

    for (const fqdn of invalidDomains) {
      expect(() =>
        validateSelfHostSpec({
          provider: 'hetzner',
          region: 'fsn1',
          fqdn,
          acmeEmail: 'ops@acme.eu',
          rawToken: 'htz_0123456789abcdef012345',
        })
      ).toThrowError(SelfHostValidationError)

      const res = safeValidateSelfHostSpec({
        provider: 'hetzner',
        region: 'fsn1',
        fqdn,
        acmeEmail: 'ops@acme.eu',
        rawToken: 'htz_0123456789abcdef012345',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe('InvalidDomain')
      }
    }
  })

  it('rejects shell-injection or malformed ACME emails and invalid regions', () => {
    for (const badEmail of [
      'ops}@acme.eu',
      'ops$(id)@acme.eu',
      'ops\0@acme.eu',
      'ops@localhost',
      'ops@127.0.0.1',
      '.ops@acme.eu',
      'ops..admin@acme.eu',
    ]) {
      const res = safeValidateSelfHostSpec({
        provider: 'ovhcloud',
        region: 'gra11',
        fqdn: 'kodera.acme.eu',
        acmeEmail: badEmail,
        rawToken: 'ovh_0123456789abcdef012345',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe('InvalidAdminEmail')
      }
    }

    for (const badRegion of ['', 'fr_par_1', 'fr par 1', 'r'.repeat(33)]) {
      const res = safeValidateSelfHostSpec({
        provider: 'hostinger',
        region: badRegion,
        fqdn: 'kodera.acme.eu',
        acmeEmail: 'ops@acme.eu',
        rawToken: 'hst_0123456789abcdef012345',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe('InvalidRegion')
      }
    }
  })

  it('enforces token length, whitespace, and printable ASCII bounds without leaking the secret', () => {
    const shortRes = safeValidateSelfHostSpec({
      provider: 'scaleway',
      region: 'fr-par-1',
      fqdn: 'kodera.acme.eu',
      acmeEmail: 'ops@acme.eu',
      rawToken: 'short_secret',
    })
    expect(shortRes).toMatchObject({ ok: false, code: 'TokenTooShort' })

    const wsSecret = 'scw_0123456789ab cdef012345'
    const wsRes = safeValidateSelfHostSpec({
      provider: 'scaleway',
      region: 'fr-par-1',
      fqdn: 'kodera.acme.eu',
      acmeEmail: 'ops@acme.eu',
      rawToken: wsSecret,
    })
    expect(wsRes).toMatchObject({ ok: false, code: 'TokenContainsWhitespace' })
    if (!wsRes.ok) {
      expect(wsRes.message).not.toContain('scw_0123456789ab')
    }

    const nulSecret = 'scw_0123456789ab\0def012345'
    const nulRes = safeValidateSelfHostSpec({
      provider: 'scaleway',
      region: 'fr-par-1',
      fqdn: 'kodera.acme.eu',
      acmeEmail: 'ops@acme.eu',
      rawToken: nulSecret,
    })
    expect(nulRes).toMatchObject({ ok: false, code: 'TokenInvalidCharacters' })

    const overlongRes = safeValidateSelfHostSpec({
      provider: 'scaleway',
      region: 'fr-par-1',
      fqdn: 'kodera.acme.eu',
      acmeEmail: 'ops@acme.eu',
      rawToken: 'k'.repeat(513),
    })
    expect(overlongRes).toMatchObject({ ok: false, code: 'TokenInvalidCharacters' })
  })
})

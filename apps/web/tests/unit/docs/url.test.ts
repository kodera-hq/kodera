import { describe, expect, it } from 'vitest'
import {
  RESERVED_DOCS_TENANT_LABELS,
  buildChannelDocsPadUrl,
  buildTenantDocsOrigin,
  isValidTenantDocsSlug,
  parseDocsPostMessageEvent,
  slugifyDocsSegment,
  validateExternalDocsUrl,
  verifyDocsPostMessageOrigin,
} from '@/features/docs'

describe('Docs URL and origin security guards', () => {
  describe('buildTenantDocsOrigin & isValidTenantDocsSlug', () => {
    it('builds the canonical HTTPS Docs origin for a valid tenant slug', () => {
      expect(buildTenantDocsOrigin('acme-sa')).toBe('https://docs.acme-sa.kodera.io')
      expect(buildTenantDocsOrigin('collectivite-42', 'staging.kodera.io')).toBe(
        'https://docs.collectivite-42.staging.kodera.io'
      )
    })

    it('rejects every reserved platform and service label', () => {
      const mandatoryReserved = [
        'admin',
        'api',
        'auth',
        'console',
        'docs',
        'errors',
        'matrix',
        'ops-admin',
        'status',
        'visio',
        'www',
      ]
      for (const label of mandatoryReserved) {
        expect(RESERVED_DOCS_TENANT_LABELS.has(label), label).toBe(true)
        expect(isValidTenantDocsSlug(label), label).toBe(false)
        expect(() => buildTenantDocsOrigin(label)).toThrow(/Invalid or reserved tenant slug/)
      }
    })

    it('rejects malformed, uppercase, punycode, synthetic, and boundary-hyphen slugs', () => {
      const invalidSlugs = [
        '',
        'a',
        '-acme',
        'acme-',
        'Acme-Sa',
        'xn--bcher-kva',
        'synth-tenant-01',
        'acme.kodera.io',
        'acme/evil',
        'a'.repeat(33),
      ]
      for (const invalid of invalidSlugs) {
        expect(isValidTenantDocsSlug(invalid), invalid).toBe(false)
        expect(() => buildTenantDocsOrigin(invalid)).toThrow()
      }
    })
  })

  describe('buildChannelDocsPadUrl & slugifyDocsSegment', () => {
    it('generates deterministic, URL-safe collaborative pad deep-links per channel', () => {
      const urlA = buildChannelDocsPadUrl({
        tenantSlug: 'acme-sa',
        channelId: '!roomAbc:acme-sa.kodera.io',
        channelName: 'Équipe Architecture & Sécurité !',
      })
      const urlB = buildChannelDocsPadUrl({
        tenantSlug: 'acme-sa',
        channelId: '!roomAbc:acme-sa.kodera.io',
        channelName: 'Équipe Architecture & Sécurité !',
      })
      expect(urlA).toBe(urlB)
      expect(urlA).toMatch(
        /^https:\/\/docs\.acme-sa\.kodera\.io\/pads\/equipe-architecture-securite-[0-9a-f]{8}$/
      )
    })

    it('disambiguates pads in the same channel when docId is provided', () => {
      const base = buildChannelDocsPadUrl({
        tenantSlug: 'acme-sa',
        channelId: 'chan-1',
        channelName: 'Général',
      })
      const secondary = buildChannelDocsPadUrl({
        tenantSlug: 'acme-sa',
        channelId: 'chan-1',
        channelName: 'Général',
        docId: 'cr-hebdo',
      })
      expect(base).not.toBe(secondary)
    })

    it('falls back to "document" when the channel name holds no ASCII alphanumeric characters', () => {
      expect(slugifyDocsSegment('🚀✨')).toBe('document')
    })
  })

  describe('validateExternalDocsUrl', () => {
    const expectedOrigin = 'https://docs.acme-sa.kodera.io'

    it('accepts a valid pad URL under the tenant Docs origin', () => {
      const res = validateExternalDocsUrl(
        'https://docs.acme-sa.kodera.io/pads/general-a1b2c3d4',
        expectedOrigin
      )
      expect(res).toEqual({
        ok: true,
        normalizedUrl: 'https://docs.acme-sa.kodera.io/pads/general-a1b2c3d4',
        origin: expectedOrigin,
      })
    })

    it('rejects javascript:, data:, and cleartext http: schemes', () => {
      expect(validateExternalDocsUrl('javascript:alert(1)', expectedOrigin)).toEqual({
        ok: false,
        reason: 'disallowed_protocol',
      })
      expect(validateExternalDocsUrl('data:text/html,<h1>x</h1>', expectedOrigin)).toEqual({
        ok: false,
        reason: 'disallowed_protocol',
      })
      expect(
        validateExternalDocsUrl('http://docs.acme-sa.kodera.io/pads/test', expectedOrigin)
      ).toEqual({
        ok: false,
        reason: 'disallowed_protocol',
      })
    })

    it('rejects cross-origin URLs, SSRF targets, embedded credentials, and path traversal', () => {
      expect(
        validateExternalDocsUrl('https://docs.other-tenant.kodera.io/pads/test', expectedOrigin)
      ).toEqual({
        ok: false,
        reason: 'origin_mismatch',
      })
      expect(
        validateExternalDocsUrl('https://169.254.169.254/latest/meta-data/', expectedOrigin)
      ).toEqual({
        ok: false,
        reason: 'origin_mismatch',
      })
      expect(
        validateExternalDocsUrl(
          'https://user:pass@docs.acme-sa.kodera.io/pads/test',
          expectedOrigin
        )
      ).toEqual({
        ok: false,
        reason: 'credentials_forbidden',
      })
      expect(
        validateExternalDocsUrl(
          'https://docs.acme-sa.kodera.io/pads/%2e%2e/admin',
          expectedOrigin
        )
      ).toEqual({
        ok: false,
        reason: 'path_traversal',
      })
    })
  })

  describe('verifyDocsPostMessageOrigin & parseDocsPostMessageEvent', () => {
    const expectedOrigin = 'https://docs.acme-sa.kodera.io'

    it('accepts exact HTTPS origin matches and rejects lookalike or insecure origins', () => {
      expect(verifyDocsPostMessageOrigin('https://docs.acme-sa.kodera.io', expectedOrigin)).toBe(
        true
      )
      expect(verifyDocsPostMessageOrigin('http://docs.acme-sa.kodera.io', expectedOrigin)).toBe(
        false
      )
      expect(
        verifyDocsPostMessageOrigin('https://docs.acme-sa.kodera.io.evil.com', expectedOrigin)
      ).toBe(false)
      expect(
        verifyDocsPostMessageOrigin('https://docs.acme-sa.kodera.io/extra', expectedOrigin)
      ).toBe(false)
      expect(verifyDocsPostMessageOrigin('null', expectedOrigin)).toBe(false)
    })

    it('parses valid handoff events and rejects untrusted origins or malformed payloads', () => {
      const validEvent = parseDocsPostMessageEvent(
        {
          origin: expectedOrigin,
          data: {
            type: 'docs:pad:title-updated',
            padId: 'pad_general_01',
            title: '  Compte-rendu Comité  ',
            padUrl: 'https://docs.acme-sa.kodera.io/pads/compte-rendu-01',
          },
        },
        expectedOrigin
      )
      expect(validEvent).toEqual({
        type: 'docs:pad:title-updated',
        padId: 'pad_general_01',
        title: 'Compte-rendu Comité',
        padUrl: 'https://docs.acme-sa.kodera.io/pads/compte-rendu-01',
      })

      expect(
        parseDocsPostMessageEvent(
          {
            origin: 'https://evil.example.com',
            data: { type: 'docs:pad:ready', padId: 'pad_01' },
          },
          expectedOrigin
        )
      ).toBeNull()

      expect(
        parseDocsPostMessageEvent(
          {
            origin: expectedOrigin,
            data: {
              type: 'docs:pad:share-to-channel',
              padId: 'pad_01',
              padUrl: 'https://evil.example.com/pads/pad_01',
            },
          },
          expectedOrigin
        )
      ).toBeNull()
    })
  })
})

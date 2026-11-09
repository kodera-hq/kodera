import type {
  SelfHostCloudProvider,
  SelfHostComposeEnvPreview,
  SelfHostDeploymentPlan,
  SelfHostDnsRecord,
  SelfHostProviderApiOrigin,
  SelfHostProviderDescriptor,
  SelfHostServiceRole,
  SelfHostSpecInput,
  SelfHostValidationErrorCode,
  SelfHostValidationResult,
} from './types'

export const REDACTED_TOKEN_PREVIEW = '[REDACTED]' as const

export const PROVIDER_API_ORIGINS: Readonly<
  Record<SelfHostCloudProvider, SelfHostProviderApiOrigin>
> = Object.freeze({
  scaleway: 'https://api.scaleway.com',
  hetzner: 'https://api.hetzner.cloud',
  hostinger: 'https://developers.hostinger.com',
  ovhcloud: 'https://eu.api.ovh.com',
})

export const SELF_HOST_PROVIDERS: readonly SelfHostProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'scaleway',
    label: 'Scaleway',
    apiOrigin: 'https://api.scaleway.com',
    defaultRegion: 'fr-par-1',
    regionExamples: Object.freeze(['fr-par-1', 'fr-par-2', 'nl-ams-1']),
  }),
  Object.freeze({
    id: 'hetzner',
    label: 'Hetzner',
    apiOrigin: 'https://api.hetzner.cloud',
    defaultRegion: 'fsn1',
    regionExamples: Object.freeze(['fsn1', 'nbg1', 'hel1']),
  }),
  Object.freeze({
    id: 'hostinger',
    label: 'Hostinger',
    apiOrigin: 'https://developers.hostinger.com',
    defaultRegion: 'eu-fr-1',
    regionExamples: Object.freeze(['eu-fr-1', 'eu-de-1', 'eu-lt-1']),
  }),
  Object.freeze({
    id: 'ovhcloud',
    label: 'OVHcloud',
    apiOrigin: 'https://eu.api.ovh.com',
    defaultRegion: 'gra11',
    regionExamples: Object.freeze(['gra11', 'sbg5', 'rbx8', 'de1']),
  }),
])

const ERROR_MESSAGES_FR: Readonly<Record<SelfHostValidationErrorCode, string>> = Object.freeze({
  InvalidProvider:
    'Fournisseur cloud non pris en charge. Choisissez Scaleway, Hetzner, Hostinger ou OVHcloud.',
  InvalidDomain:
    'Domaine public invalide. Indiquez un FQDN public valide (hors localhost, .local, .internal et adresses IP brutes).',
  InvalidAdminEmail:
    "Adresse e-mail ACME invalide. Indiquez une adresse d'administrateur sur un domaine public valide.",
  InvalidRegion:
    'Région fournisseur invalide (1 à 32 caractères ASCII alphanumériques ou tirets).',
  TokenTooShort: 'Le jeton API fournisseur doit comporter au moins 16 caractères ASCII.',
  TokenContainsWhitespace: 'Le jeton API fournisseur ne doit contenir aucun espace ou retour chariot.',
  TokenInvalidCharacters:
    'Le jeton API fournisseur contient des caractères invalides ou dépasse 512 caractères.',
})

export class SelfHostValidationError extends Error {
  readonly code: SelfHostValidationErrorCode

  constructor(code: SelfHostValidationErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES_FR[code])
    this.name = 'SelfHostValidationError'
    this.code = code
  }
}

export function isValidCloudProvider(value: string): value is SelfHostCloudProvider {
  return (
    value === 'scaleway' ||
    value === 'hetzner' ||
    value === 'hostinger' ||
    value === 'ovhcloud'
  )
}

export function isValidProviderRegion(region: string): boolean {
  if (typeof region !== 'string') return false
  if (region.length < 1 || region.length > 32) return false
  return /^[A-Za-z0-9-]+$/.test(region)
}

/**
 * Validates a public FQDN matching `apps/desktop/src-tauri` `is_valid_public_fqdn`:
 * - 4..=253 ASCII characters
 * - no leading or trailing dot
 * - rejects `localhost`, `.localhost`, `.local`, `.internal`, `.arpa`, and IPv4/IPv6 literals
 * - at least 2 labels, each 1..=63 `[a-z0-9-]` not starting or ending with `-`
 * - alphabetic TLD of 2..=63 characters
 */
export function isValidPublicFqdn(fqdn: string): boolean {
  if (typeof fqdn !== 'string') return false
  if (fqdn.length < 4 || fqdn.length > 253) return false
  if (fqdn.startsWith('.') || fqdn.endsWith('.')) return false
  if (fqdn.includes(':') || fqdn.startsWith('[') || fqdn.endsWith(']')) return false

  const lower = fqdn.toLowerCase()
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    return false
  }

  const labels = lower.split('.')
  if (labels.length < 2) return false

  const tld = labels[labels.length - 1]
  if (tld === undefined || tld.length < 2 || tld.length > 63 || !/^[a-z]+$/.test(tld)) {
    return false
  }

  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-') &&
      /^[a-z0-9-]+$/.test(label)
  )
}

/**
 * Validates an ACME contact email matching `apps/desktop/src-tauri` `is_valid_email`:
 * - strict `local@domain` split with a single `@`
 * - `local` 1..=64 ASCII `[A-Za-z0-9._%+-]`, not starting/ending with `.` and no `..`
 * - `domain` is a valid public FQDN
 */
export function isValidAcmeEmail(email: string): boolean {
  if (typeof email !== 'string') return false
  const atIndex = email.indexOf('@')
  if (atIndex <= 0 || email.indexOf('@', atIndex + 1) !== -1) return false

  const local = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)

  if (local.length < 1 || local.length > 64) return false
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return false

  return isValidPublicFqdn(domain.toLowerCase())
}

/**
 * Validates an ephemeral provider API token (`16..=512` printable ASCII `0x21..=0x7E` with zero whitespace).
 * Never echoes the token in thrown errors.
 */
export function validateProviderToken(rawToken: string): void {
  if (typeof rawToken !== 'string') {
    throw new SelfHostValidationError('TokenTooShort')
  }
  const trimmed = rawToken.trim()
  if (trimmed.length < 16) {
    throw new SelfHostValidationError('TokenTooShort')
  }
  if (rawToken.length > 512 || trimmed.length > 512) {
    throw new SelfHostValidationError('TokenInvalidCharacters')
  }
  if (/\s/.test(rawToken)) {
    throw new SelfHostValidationError('TokenContainsWhitespace')
  }
  for (let i = 0; i < rawToken.length; i += 1) {
    const code = rawToken.charCodeAt(i)
    if (code < 0x21 || code > 0x7e) {
      throw new SelfHostValidationError('TokenInvalidCharacters')
    }
  }
}

export function buildSelfHostDnsRecords(fqdn: string): readonly SelfHostDnsRecord[] {
  const normalizedFqdn = fqdn.trim().toLowerCase()
  const hosts: ReadonlyArray<{ readonly service: SelfHostServiceRole; readonly host: string }> = [
    { service: 'workspace', host: normalizedFqdn },
    { service: 'matrix', host: `matrix.${normalizedFqdn}` },
    { service: 'visio', host: `visio.${normalizedFqdn}` },
    { service: 'docs', host: `docs.${normalizedFqdn}` },
    { service: 'auth', host: `auth.${normalizedFqdn}` },
  ]

  const records: SelfHostDnsRecord[] = []
  for (const entry of hosts) {
    records.push(
      Object.freeze({
        type: 'A',
        name: entry.host,
        host: entry.host,
        service: entry.service,
        target: '<IPV4_PUBLIQUE_VPS>',
        ttl: 300,
      }),
      Object.freeze({
        type: 'AAAA',
        name: entry.host,
        host: entry.host,
        service: entry.service,
        target: '<IPV6_PUBLIQUE_VPS>',
        ttl: 300,
      })
    )
  }

  return Object.freeze(records)
}

export function buildComposeEnvPreview(
  fqdn: string,
  acmeEmail: string
): SelfHostComposeEnvPreview {
  const normalizedFqdn = fqdn.trim().toLowerCase()
  const normalizedEmail = acmeEmail.trim()
  return Object.freeze({
    KODERA_PUBLIC_DOMAIN: normalizedFqdn,
    KODERA_MATRIX_HOST: `matrix.${normalizedFqdn}`,
    KODERA_VISIO_HOST: `visio.${normalizedFqdn}`,
    KODERA_DOCS_HOST: `docs.${normalizedFqdn}`,
    KODERA_AUTH_HOST: `auth.${normalizedFqdn}`,
    KODERA_ACME_EMAIL: normalizedEmail,
    KODERA_PROVIDER_TOKEN: REDACTED_TOKEN_PREVIEW,
  })
}

/**
 * Validates a 1-click self-host specification and returns a deterministic `SelfHostDeploymentPlan`
 * whose token fields are unconditionally redacted (`"[REDACTED]"`).
 */
export function validateSelfHostSpec(input: SelfHostSpecInput): SelfHostDeploymentPlan {
  const providerNorm = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : ''
  if (!isValidCloudProvider(providerNorm)) {
    throw new SelfHostValidationError('InvalidProvider')
  }

  const fqdnNorm = typeof input.fqdn === 'string' ? input.fqdn.trim().toLowerCase() : ''
  if (!isValidPublicFqdn(fqdnNorm)) {
    throw new SelfHostValidationError('InvalidDomain')
  }

  const emailNorm = typeof input.acmeEmail === 'string' ? input.acmeEmail.trim() : ''
  if (!isValidAcmeEmail(emailNorm)) {
    throw new SelfHostValidationError('InvalidAdminEmail')
  }

  const regionNorm = typeof input.region === 'string' ? input.region.trim() : ''
  if (!isValidProviderRegion(regionNorm)) {
    throw new SelfHostValidationError('InvalidRegion')
  }

  validateProviderToken(input.rawToken)

  const apiOrigin = PROVIDER_API_ORIGINS[providerNorm]
  const dnsRecords = buildSelfHostDnsRecords(fqdnNorm)
  const composeEnvPreview = buildComposeEnvPreview(fqdnNorm, emailNorm)

  return Object.freeze({
    provider: providerNorm,
    apiOrigin,
    region: regionNorm,
    fqdn: fqdnNorm,
    acmeEmail: emailNorm,
    redactedTokenPreview: REDACTED_TOKEN_PREVIEW,
    dnsRecords,
    composeEnvPreview,
  })
}

export function safeValidateSelfHostSpec(input: SelfHostSpecInput): SelfHostValidationResult {
  try {
    const plan = validateSelfHostSpec(input)
    return Object.freeze({ ok: true, plan })
  } catch (error) {
    if (error instanceof SelfHostValidationError) {
      return Object.freeze({
        ok: false,
        code: error.code,
        message: error.message,
      })
    }
    return Object.freeze({
      ok: false,
      code: 'InvalidDomain',
      message: ERROR_MESSAGES_FR.InvalidDomain,
    })
  }
}

export type SelfHostCloudProvider = 'scaleway' | 'hetzner' | 'hostinger' | 'ovhcloud'

export type SelfHostProviderApiOrigin =
  | 'https://api.scaleway.com'
  | 'https://api.hetzner.cloud'
  | 'https://developers.hostinger.com'
  | 'https://eu.api.ovh.com'

export type SelfHostValidationErrorCode =
  | 'InvalidProvider'
  | 'InvalidDomain'
  | 'InvalidAdminEmail'
  | 'InvalidRegion'
  | 'TokenTooShort'
  | 'TokenContainsWhitespace'
  | 'TokenInvalidCharacters'

export type SelfHostDnsRecordType = 'A' | 'AAAA'

export type SelfHostServiceRole = 'workspace' | 'matrix' | 'visio' | 'docs' | 'auth'

export interface SelfHostDnsRecord {
  readonly type: SelfHostDnsRecordType
  readonly name: string
  readonly host: string
  readonly service: SelfHostServiceRole
  readonly target: string
  readonly ttl: number
}

export interface SelfHostComposeEnvPreview {
  readonly KODERA_PUBLIC_DOMAIN: string
  readonly KODERA_MATRIX_HOST: string
  readonly KODERA_VISIO_HOST: string
  readonly KODERA_DOCS_HOST: string
  readonly KODERA_AUTH_HOST: string
  readonly KODERA_ACME_EMAIL: string
  readonly KODERA_PROVIDER_TOKEN: '[REDACTED]'
}

export interface SelfHostSpecInput {
  readonly provider: string
  readonly region: string
  readonly fqdn: string
  readonly acmeEmail: string
  readonly rawToken: string
}

export interface SelfHostDeploymentPlan {
  readonly provider: SelfHostCloudProvider
  readonly apiOrigin: SelfHostProviderApiOrigin
  readonly region: string
  readonly fqdn: string
  readonly acmeEmail: string
  readonly redactedTokenPreview: '[REDACTED]'
  readonly dnsRecords: readonly SelfHostDnsRecord[]
  readonly composeEnvPreview: SelfHostComposeEnvPreview
}

export interface SelfHostProviderDescriptor {
  readonly id: SelfHostCloudProvider
  readonly label: string
  readonly apiOrigin: SelfHostProviderApiOrigin
  readonly defaultRegion: string
  readonly regionExamples: readonly string[]
}

export type SelfHostValidationResult =
  | {
      readonly ok: true
      readonly plan: SelfHostDeploymentPlan
    }
  | {
      readonly ok: false
      readonly code: SelfHostValidationErrorCode
      readonly message: string
    }

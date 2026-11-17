import { securityWorkerClient } from './security-worker-client'

export interface VerificationPrincipal {
  readonly organisationId: string
  readonly accountId: string
}
export interface VerificationDevice {
  readonly id: string
  readonly pub: string
}
export interface CrossSigningContext extends VerificationPrincipal {
  readonly deviceId: string
}
export interface Endorsement {
  readonly statement: string
  readonly signature: string
}
export interface SasInput extends VerificationPrincipal {
  readonly deviceA: VerificationDevice
  readonly deviceB: VerificationDevice
  readonly sessionNonce: string
}
export interface SecurityCodes {
  readonly decimal: readonly string[]
  readonly symbols: readonly string[]
}
export interface PublicEndorser extends VerificationDevice {
  readonly keyId: string
}
export function createCrossSigningClient(context: CrossSigningContext) {
  const client = securityWorkerClient(
    new Worker(new URL('./cross-signing.worker.ts', import.meta.url), {
      type: 'module',
      name: 'device-verification',
    }),
    context
  )
  return Object.freeze({
    close: client.close,
    publicIdentity: () => client.run('identity', null) as Promise<PublicEndorser>,
    endorse: (target: VerificationDevice) => client.run('endorse', target) as Promise<Endorsement>,
    verify: (endorsement: Endorsement, endorser: PublicEndorser, target: VerificationDevice) =>
      client.run('verify', { endorsement, endorser, target }) as Promise<boolean>,
    securityCodes: (input: SasInput) => client.run('sas', input) as Promise<SecurityCodes>,
  })
}

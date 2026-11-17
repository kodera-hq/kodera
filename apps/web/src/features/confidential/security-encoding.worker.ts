import { fields, need, text } from './crypto-session.worker-core'
import type { VerificationPrincipal } from './cross-signing-client'

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
export function unbase64(value: unknown, lengths: readonly number[]): Uint8Array<ArrayBuffer> {
  need(typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(value))
  const bytes = Uint8Array.from(atob(value), (v) => v.charCodeAt(0))
  need(lengths.includes(bytes.length) && base64(bytes) === value)
  return bytes
}
export function verificationPrincipal(input: unknown): VerificationPrincipal {
  const p = fields(input, ['organisationId', 'accountId'])
  text(p.organisationId)
  text(p.accountId)
  return Object.freeze({ organisationId: p.organisationId, accountId: p.accountId })
}

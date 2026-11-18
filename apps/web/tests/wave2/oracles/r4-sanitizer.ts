import type { APIRequestContext } from '@playwright/test'
import { exactOrigin, guard, object } from './shared'

export interface TargetGate {
  webOrigin: string
  apiOrigin: string
  authOrigin: string
  realm: string
  webRevision: string
}

export function assertTargetGate(
  expected: TargetGate,
  actual: {
    release: unknown
    realm: unknown
    apiOrigin: unknown
    issuer: unknown
  }
): void {
  ;[expected.webOrigin, expected.apiOrigin, expected.authOrigin].forEach(exactOrigin)
  guard(/^[a-f0-9]{40}$/.test(expected.webRevision), 'R4_REVISION_REQUIRED')
  guard(/^[a-zA-Z0-9_-]+$/.test(expected.realm), 'R4_REALM_REQUIRED')
  guard(
    object(actual.release) && actual.release.web_revision === expected.webRevision,
    'R4_WEB_REVISION'
  )
  guard(actual.realm === expected.realm, 'R4_REALM')
  guard(actual.apiOrigin === expected.apiOrigin, 'R4_API_ORIGIN')
  guard(actual.issuer === `${expected.authOrigin}/realms/${expected.realm}`, 'R4_ISSUER')
}

/** Read-only opening gate. Discovery must be the actual deployed realm's public OIDC metadata. */
export async function openTargetGate(request: APIRequestContext, expected: TargetGate) {
  ;[expected.webOrigin, expected.apiOrigin, expected.authOrigin].forEach(exactOrigin)
  const release = await request.get(`${expected.webOrigin}/release.json`, { maxRedirects: 0 })
  const discovery = await request.get(
    `${expected.authOrigin}/realms/${encodeURIComponent(expected.realm)}/.well-known/openid-configuration`,
    { maxRedirects: 0 }
  )
  const api = await request.get(`${expected.apiOrigin}/api/v1/me`, { maxRedirects: 0 })
  guard(release.status() === 200 && discovery.status() === 200, 'R4_OPENING_STATUS')
  guard(api.status() === 401 && api.url() === `${expected.apiOrigin}/api/v1/me`, 'R4_API_PROBE')
  guard(
    [release, discovery, api].every((response) =>
      /^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(response.headers()['content-type'] ?? '')
    ),
    'R4_OPENING_JSON'
  )
  const metadata: unknown = await discovery.json()
  const build: unknown = await release.json()
  guard(object(metadata) && object(build), 'R4_OPENING_SHAPE')
  assertTargetGate(expected, {
    release: build,
    realm: expected.realm,
    issuer: metadata.issuer,
    apiOrigin: new URL(api.url()).origin,
  })
  return {
    web_revision: expected.webRevision,
    realm: expected.realm,
    apiOrigin: expected.apiOrigin,
  }
}

const sensitiveKey =
  /^(?:api_key|code|code_verifier|token|access_token|refresh_token|id_token|loginToken|secret|password|totpBase32|authorization|cookie|set-cookie|signature)$/i
const secretPattern =
  /[?&](?:code|loginToken|access_token|refresh_token|id_token|code_verifier|token|secret|X-Amz-Credential|X-Amz-Security-Token|X-Amz-Signature|AWSAccessKeyId|Signature)=|\bsyt_[A-Za-z0-9_-]+|\bmda_[A-Za-z0-9_-]+|Bearer[\s+]|eyJ[A-Za-z0-9_-]*|#|phc_/i

export function safeString(
  value: string,
  fixtureSecrets: Iterable<string> = [],
  isKey = false
): void {
  const secrets = [...fixtureSecrets].filter((secret) => secret.length > 0)
  let decoded = value
  for (let pass = 0; ; pass++) {
    guard(
      !secretPattern.test(decoded) &&
        !secrets.some(
          (secret) => decoded.includes(secret) || decoded.replace(/\+/g, ' ').includes(secret)
        ) &&
        (!isKey || !sensitiveKey.test(decoded)),
      'R4_SECRET_RECEIPT'
    )
    if (pass === 4) {
      guard(!/%[0-9a-f]{2}/i.test(decoded), 'R4_ENCODED_RECEIPT')
      return
    }
    let next: string
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, ' '))
    } catch {
      throw new Error('R4_ENCODED_RECEIPT')
    }
    if (next === decoded) return
    decoded = next
  }
}

/** Only plain JSON data is admissible; no toJSON hooks, getters, cycles or hidden properties. */
export function validateReceipt(value: unknown, fixtureSecrets: Iterable<string> = []): void {
  const secrets = [...fixtureSecrets]
  const seen = new Set<object>()
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') return safeString(entry, secrets)
    if (entry === null || typeof entry === 'boolean') return
    if (typeof entry === 'number') return guard(Number.isFinite(entry), 'R4_JSON_NUMBER')
    guard(typeof entry === 'object' && entry !== null, 'R4_JSON_DATA')
    guard(!seen.has(entry), 'R4_JSON_CYCLE')
    seen.add(entry)
    guard(
      Array.isArray(entry) ||
        Object.getPrototypeOf(entry) === Object.prototype ||
        Object.getPrototypeOf(entry) === null,
      'R4_JSON_PROTOTYPE'
    )
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(entry) && key === 'length') continue
      guard(typeof key === 'string', 'R4_JSON_KEY')
      safeString(key, secrets, true)
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
      guard(descriptor.enumerable && 'value' in descriptor, 'R4_JSON_DESCRIPTOR')
      visit(descriptor.value)
    }
    seen.delete(entry)
  }
  visit(value)
}

/** Deliberately select evidence fields, never headers, bodies, query strings or raw fixture IDs. */
export function redactNetworkReceipt(value: {
  surface: string
  actor: string
  origin: string
  method: string
  pathPattern: string
  expectedStatus: number
  actualStatus: number
}) {
  const receipt = {
    surface: value.surface,
    actor: value.actor,
    origin: exactOrigin(value.origin),
    method: value.method,
    pathPattern: value.pathPattern,
    expectedStatus: value.expectedStatus,
    actualStatus: value.actualStatus,
  }
  guard(
    /^(?:S\d{2}|L\d{2}|A\d{2})$/.test(receipt.surface) && /^[A-Z][A-Z0-9_-]*$/.test(receipt.actor),
    'R4_RECEIPT_ALIAS'
  )
  guard(/^\/[A-Za-z0-9_./{}-]*$/.test(receipt.pathPattern), 'R4_RECEIPT_TEMPLATE')
  validateReceipt(receipt)
  return Object.freeze(receipt)
}

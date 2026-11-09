import type {
  ChannelDocsPadUrlOptions,
  DocsPostMessageEventType,
  DocsPostMessagePayload,
  DocsUrlValidationResult,
} from './types'

const DEFAULT_BASE_DOMAIN = 'kodera.io'

/**
 * Lowercase DNS label rule matching Core `apps/tenancy/models.py` (`SLUG`) and RFC 1123:
 * 2 to 63 lowercase ASCII alphanumeric characters or hyphens, starting and ending with
 * an alphanumeric character, and never using punycode (`xn--`).
 */
const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/

const BASE_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * Reserved platform and service labels under `kodera.io` (Core contract 0.38.0 / 0.39.0,
 * `RESERVED_TENANT_SLUGS` + `RESERVED_ORGANISATION_SLUGS` + application subdomains).
 */
export const RESERVED_DOCS_TENANT_LABELS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'auth-admin',
  'auth-mail',
  'billing',
  'console',
  'developers',
  'docs',
  'drive',
  'errors',
  'grist',
  'id',
  'identity',
  'kodera',
  'kodera-dev',
  'kodera-probe',
  'kodera-staff',
  'mail',
  'master',
  'matrix',
  'notify',
  'ops-admin',
  'staff',
  'staging',
  'status',
  'support',
  'visio',
  'www',
])

const ALLOWED_POST_MESSAGE_TYPES: ReadonlySet<DocsPostMessageEventType> = new Set([
  'docs:pad:ready',
  'docs:pad:title-updated',
  'docs:pad:share-to-channel',
])

export function isValidTenantDocsSlug(tenantSlug: string): boolean {
  if (typeof tenantSlug !== 'string') return false
  if (tenantSlug.length < 2 || tenantSlug.length > 32) return false
  if (!TENANT_SLUG_RE.test(tenantSlug)) return false
  if (tenantSlug.startsWith('xn--') || tenantSlug.startsWith('synth-')) return false
  if (RESERVED_DOCS_TENANT_LABELS.has(tenantSlug)) return false
  return true
}

function normalizeBaseDomain(baseDomain?: string): string {
  const domain = (baseDomain ?? DEFAULT_BASE_DOMAIN).trim().toLowerCase()
  if (!BASE_DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid Docs base domain: ${baseDomain ?? ''}`)
  }
  return domain
}

/**
 * Builds the canonical HTTPS origin for a tenant's dedicated DINUM Docs instance:
 * `https://docs.<tenantSlug>.<baseDomain>`.
 */
export function buildTenantDocsOrigin(
  tenantSlug: string,
  baseDomain: string = DEFAULT_BASE_DOMAIN
): string {
  if (!isValidTenantDocsSlug(tenantSlug)) {
    throw new Error(
      `Invalid or reserved tenant slug for Docs origin: ${JSON.stringify(tenantSlug)}`
    )
  }
  const normalizedDomain = normalizeBaseDomain(baseDomain)
  return `https://docs.${tenantSlug}.${normalizedDomain}`
}

/**
 * Deterministic 32-bit FNV-1a hash formatted as 8 lowercase hex characters,
 * used to disambiguate channel collaborative pad slugs without exposing raw tokens.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Converts a human channel or document name into a URL-safe ASCII slug.
 */
export function slugifyDocsSegment(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')

  return normalized.length > 0 ? normalized : 'document'
}

/**
 * Builds a deterministic, URL-safe collaborative pad URL for an Espace channel:
 * `https://docs.<tenantSlug>.<baseDomain>/pads/<slugified-channel>-<short-hash>`
 */
export function buildChannelDocsPadUrl(options: ChannelDocsPadUrlOptions): string {
  const origin = buildTenantDocsOrigin(options.tenantSlug, options.baseDomain)
  const channelId = options.channelId.trim()
  if (channelId.length === 0) {
    throw new Error('channelId is required to build a channel Docs pad URL')
  }
  const slugSegment = slugifyDocsSegment(options.channelName)
  const seed = options.docId ? `${channelId}:${options.docId.trim()}` : channelId
  const shortHash = fnv1aHex(seed)
  return `${origin}/pads/${slugSegment}-${shortHash}`
}

/**
 * Validates a candidate DINUM Docs URL against open-redirect, SSRF, credential injection,
 * path traversal, and non-HTTPS schemes (`javascript:`, `data:`, `http:`, `file:`).
 */
export function validateExternalDocsUrl(
  rawUrl: string,
  expectedDocsOrigin: string
): DocsUrlValidationResult {
  let expected: URL
  try {
    expected = new URL(expectedDocsOrigin)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (expected.protocol !== 'https:' || expected.username !== '' || expected.password !== '') {
    return { ok: false, reason: 'disallowed_protocol' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'disallowed_protocol' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials_forbidden' }
  }
  if (parsed.origin !== expected.origin) {
    return { ok: false, reason: 'origin_mismatch' }
  }

  if (
    /(?:^|[\\/])(?:\.\.|%2e%2e|%252e%252e)(?:[\\/]|$)/i.test(rawUrl) ||
    rawUrl.includes('\\')
  ) {
    return { ok: false, reason: 'path_traversal' }
  }

  const decodedPath = (() => {
    try {
      return decodeURIComponent(parsed.pathname)
    } catch {
      return null
    }
  })()
  if (
    decodedPath === null ||
    decodedPath.includes('..') ||
    decodedPath.includes('\\') ||
    parsed.pathname.includes('//')
  ) {
    return { ok: false, reason: 'path_traversal' }
  }

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    origin: parsed.origin,
  }
}

/**
 * Strictly verifies the `MessageEvent.origin` of a DINUM Docs window/iframe handoff event.
 */
export function verifyDocsPostMessageOrigin(
  eventOrigin: string,
  expectedDocsOrigin: string
): boolean {
  if (typeof eventOrigin !== 'string' || typeof expectedDocsOrigin !== 'string') {
    return false
  }
  try {
    const actual = new URL(eventOrigin)
    const expected = new URL(expectedDocsOrigin)
    if (actual.protocol !== 'https:' || expected.protocol !== 'https:') {
      return false
    }
    if (actual.username !== '' || actual.password !== '') {
      return false
    }
    if (actual.pathname !== '/' || actual.search !== '' || actual.hash !== '') {
      // A browser origin string never carries a path, query, or fragment;
      // only `https://host[:port]` is a genuine origin.
      if (eventOrigin !== actual.origin) return false
    }
    return actual.origin === expected.origin && eventOrigin === expected.origin
  } catch {
    return false
  }
}

/**
 * Validates and extracts a typed `DocsPostMessagePayload` from an untrusted `postMessage` event.
 * Returns `null` if the origin does not match `expectedDocsOrigin` or the payload is malformed.
 */
export function parseDocsPostMessageEvent(
  event: { readonly origin: string; readonly data: unknown },
  expectedDocsOrigin: string
): DocsPostMessagePayload | null {
  if (!verifyDocsPostMessageOrigin(event.origin, expectedDocsOrigin)) {
    return null
  }
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    return null
  }
  const record = event.data as Record<string, unknown>
  const type = record['type']
  const padId = record['padId']
  if (typeof type !== 'string' || !ALLOWED_POST_MESSAGE_TYPES.has(type as DocsPostMessageEventType)) {
    return null
  }
  if (typeof padId !== 'string' || !/^[a-zA-Z0-9_-]{2,80}$/.test(padId)) {
    return null
  }

  const title = record['title']
  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > 200)) {
    return null
  }

  const padUrl = record['padUrl']
  let normalizedPadUrl: string | undefined
  if (padUrl !== undefined) {
    if (typeof padUrl !== 'string') return null
    const validated = validateExternalDocsUrl(padUrl, expectedDocsOrigin)
    if (!validated.ok) return null
    normalizedPadUrl = validated.normalizedUrl
  }

  return {
    type: type as DocsPostMessageEventType,
    padId,
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(normalizedPadUrl !== undefined ? { padUrl: normalizedPadUrl } : {}),
  }
}

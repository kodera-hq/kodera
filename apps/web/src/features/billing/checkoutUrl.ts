// Safe redirect and pre-signed download URL checks for billing and checkout flows.
// Stripe Checkout sessions must use HTTPS on an allowlisted host with no embedded
// credentials, custom port, whitespace, or ASCII control characters.

const ALLOWED_STRIPE_CHECKOUT_HOSTS: ReadonlySet<string> = new Set(['checkout.stripe.com'])

// Reserved RFC 2606 / RFC 6761 synthetic hosts used exclusively by OpenAPI contract
// examples and local MSW / Vitest suites. Never accepted in production builds.
const SYNTHETIC_TEST_CHECKOUT_HOSTS: ReadonlySet<string> = new Set([
  'pay.example.invalid',
  'payments.example.test',
])

function hasUnsafeUrlCharacters(raw: string): boolean {
  if (/\s/.test(raw)) return true
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isIsoFutureTimestamp(value: unknown, nowMs = Date.now()): value is string {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs
}

function defaultAllowSyntheticHosts(): boolean {
  return import.meta.env.MODE === 'test' || import.meta.env.VITE_ENABLE_MSW === 'true'
}

export interface CheckoutRedirectValidationOptions {
  allowSyntheticTestHosts?: boolean
}

export function isAllowedCheckoutRedirectUrl(
  rawUrl: unknown,
  options: CheckoutRedirectValidationOptions = {}
): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false
  if (hasUnsafeUrlCharacters(rawUrl)) return false

  const allowSynthetic = options.allowSyntheticTestHosts ?? defaultAllowSyntheticHosts()

  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username !== '' || parsed.password !== '') return false
    if (parsed.port !== '') return false
    const host = parsed.hostname.toLowerCase()
    if (host.length === 0) return false
    if (ALLOWED_STRIPE_CHECKOUT_HOSTS.has(host)) return true
    if (allowSynthetic && SYNTHETIC_TEST_CHECKOUT_HOSTS.has(host)) return true
    return false
  } catch {
    return false
  }
}

export function isSafePresignedDownloadUrl(
  rawUrl: unknown,
  expiresAt: unknown,
  nowMs = Date.now()
): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false
  if (!isIsoFutureTimestamp(expiresAt, nowMs)) return false
  if (hasUnsafeUrlCharacters(rawUrl)) return false

  try {
    const parsed = new URL(rawUrl)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

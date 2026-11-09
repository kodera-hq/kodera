export type WebhookScheme = 'kodera' | 'github'
export interface WebhookExample {
  scheme: WebhookScheme
  secret: string
  payload: string
  timestamp: string
}
export class WebhookExampleError extends Error {
  constructor(
    readonly code:
      | 'SECRET_BOUNDS'
      | 'PAYLOAD_BOUNDS'
      | 'INVALID_PAYLOAD'
      | 'TIMESTAMP'
      | 'EXPIRED'
      | 'CRYPTO_UNAVAILABLE'
  ) {
    super(code)
  }
}
function inputs(input: WebhookExample) {
  if (typeof input.secret !== 'string' || input.secret.length < 16 || input.secret.length > 4096)
    throw new WebhookExampleError('SECRET_BOUNDS')
  if (typeof input.payload !== 'string' || input.payload.length > 65_536)
    throw new WebhookExampleError('PAYLOAD_BOUNDS')
  const secret = new TextEncoder().encode(input.secret)
  const payload = new TextEncoder().encode(input.payload)
  if (input.secret.length < 16 || secret.length > 4096)
    throw new WebhookExampleError('SECRET_BOUNDS')
  if (payload.length > 65_536) throw new WebhookExampleError('PAYLOAD_BOUNDS')
  let data: unknown
  try {
    data = JSON.parse(input.payload)
  } catch {
    throw new WebhookExampleError('INVALID_PAYLOAD')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new WebhookExampleError('INVALID_PAYLOAD')
  if (input.scheme !== 'kodera' && input.scheme !== 'github')
    throw new WebhookExampleError('INVALID_PAYLOAD')
  if (
    input.scheme === 'kodera' &&
    (!/^(0|[1-9]\d{0,15})$/u.test(input.timestamp) ||
      !Number.isSafeInteger(Number(input.timestamp)))
  )
    throw new WebhookExampleError('TIMESTAMP')
  if (!globalThis.crypto?.subtle) throw new WebhookExampleError('CRYPTO_UNAVAILABLE')
  const transcript =
    input.scheme === 'kodera'
      ? new TextEncoder().encode(`${input.timestamp}.${input.payload}`)
      : payload
  return { secret, transcript }
}
export async function signExampleWebhook(input: WebhookExample): Promise<string> {
  const { secret, transcript } = inputs(input)
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, transcript)
  const prefix = input.scheme === 'kodera' ? 'v1=' : 'sha256='
  return (
    prefix +
    Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
  )
}
export async function verifyExampleWebhook(
  input: WebhookExample & { signature: string },
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const { secret, transcript } = inputs(input)
  if (input.scheme === 'kodera') {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
      throw new WebhookExampleError('TIMESTAMP')
    if (Math.abs(nowSeconds - Number(input.timestamp)) > 300)
      throw new WebhookExampleError('EXPIRED')
  }
  const pattern = input.scheme === 'kodera' ? /^v1=([a-f0-9]{64})$/u : /^sha256=([a-f0-9]{64})$/u
  const hex = pattern.exec(input.signature)?.[1]
  if (!hex) return false
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16))
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify('HMAC', key, bytes, transcript)
}

/** Browser-only counterpart of extension-sdk's v1 webhook transcript. Never delivers a request. */
export type WebhookTestError =
  | 'INVALID_SECRET'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_OUT_OF_RANGE'
  | 'SIGNATURE_MISMATCH'
  | 'INVALID_JSON'
  | 'UNAVAILABLE'

export class WebhookTestFailure extends Error {
  constructor(readonly code: WebhookTestError) {
    super(code)
  }
}

function timestampValue(timestamp: string): number {
  if (!/^(0|[1-9]\d{0,15})$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) {
    throw new WebhookTestFailure('INVALID_TIMESTAMP')
  }
  return Number(timestamp)
}

async function signingKey(secret: string) {
  if (secret.length < 16) throw new WebhookTestFailure('INVALID_SECRET')
  if (!globalThis.crypto?.subtle) throw new WebhookTestFailure('UNAVAILABLE')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export async function signTestWebhook(secret: string, timestamp: string, body: string) {
  timestampValue(timestamp)
  const key = await signingKey(secret)
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  )
  return `v1=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function verifyTestWebhook(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  now = Math.floor(Date.now() / 1000)
) {
  const seconds = timestampValue(timestamp)
  if (!Number.isSafeInteger(now) || now < 0 || Math.abs(now - seconds) > 300) {
    throw new WebhookTestFailure('TIMESTAMP_OUT_OF_RANGE')
  }
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) {
    throw new WebhookTestFailure('SIGNATURE_MISMATCH')
  }
  const key = await signingKey(secret)
  const mac = Uint8Array.from(signature.slice(3).match(/../g)!, (byte) => parseInt(byte, 16))
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      mac,
      new TextEncoder().encode(`${timestamp}.${body}`)
    ))
  ) {
    throw new WebhookTestFailure('SIGNATURE_MISMATCH')
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
  } catch {
    throw new WebhookTestFailure('INVALID_JSON')
  }
}

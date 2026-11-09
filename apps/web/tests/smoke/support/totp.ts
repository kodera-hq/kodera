// RFC 6238 over HMAC-SHA1, 30 s, six digits: the realms' OTP policy. A code is single-use
// (`otpPolicyCodeReusable: false`), so a second sign-in in the same step waits for the next one.
import { createHmac } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PERIOD = 30
const used = new Map<string, number>()

function base32(text: string): Buffer {
  let bits = ''
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('not Base32')
    bits += index.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let at = 0; at + 8 <= bits.length; at += 8) bytes.push(parseInt(bits.slice(at, at + 8), 2))
  return Buffer.from(bytes)
}

export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / PERIOD)))
  const digest = createHmac('sha1', base32(secretBase32)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** A code no earlier call returned for this secret, waiting for the next step if need be. */
export async function freshCode(secretBase32: string): Promise<string> {
  let step = Math.floor(Date.now() / 1000 / PERIOD)
  if (used.get(secretBase32) === step) {
    await new Promise((resolve) =>
      setTimeout(resolve, (step + 1) * PERIOD * 1000 - Date.now() + 250)
    )
    step = Math.floor(Date.now() / 1000 / PERIOD)
  }
  used.set(secretBase32, step)
  return totp(secretBase32)
}

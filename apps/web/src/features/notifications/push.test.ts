import { describe, expect, it } from 'vitest'
import { applicationServerKey, PushRefused, subscriptionKeys } from './push'

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
}

const point = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65))
  bytes[0] = 4
  return bytes
}

describe('Web Push keys', () => {
  it('reads Core’s VAPID key as an uncompressed P-256 point', () => {
    const key = point()
    expect(applicationServerKey(base64url(key))).toEqual(key)
  })

  it('refuses a key of another shape', () => {
    const wrong = point()
    wrong[0] = 2
    for (const bad of [base64url(wrong), 'short', `${base64url(point())}!`]) {
      expect(() => applicationServerKey(bad)).toThrow(PushRefused)
    }
  })

  it('files only an https endpoint with keys of the contract’s sizes', () => {
    const p256dh = base64url(point())
    const auth = base64url(crypto.getRandomValues(new Uint8Array(16)))
    expect(p256dh).toHaveLength(87)
    expect(auth).toHaveLength(22)
    const endpoint = 'https://push.exemple.fr/send/abc'
    expect(subscriptionKeys({ endpoint, keys: { p256dh, auth } })).toEqual({
      endpoint,
      p256dh,
      auth,
    })
    for (const bad of [
      { endpoint: 'http://push.exemple.fr/x', keys: { p256dh, auth } },
      { endpoint: 'https://u:p@push.exemple.fr/x', keys: { p256dh, auth } },
      { endpoint: 'javascript:alert(1)', keys: { p256dh, auth } },
      { endpoint, keys: { p256dh: 'x', auth } },
      { endpoint, keys: { p256dh, auth: `${auth}=` } },
      { endpoint },
    ]) {
      expect(() => subscriptionKeys(bad)).toThrow(PushRefused)
    }
  })
})

describe('the push worker', () => {
  it('never reads a push payload', async () => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const source = await readFile(resolve(process.cwd(), 'public/push-sw.js'), 'utf8')
    // The one `.data` read is the page's message to the worker; a push's is never touched.
    expect(source.match(/\b\w+\.data\b/gu)).toEqual(['message.data'])
    expect(source).not.toMatch(/push\.data/u)
    expect(source).not.toMatch(/\bfetch\(/u)
    expect(source).not.toMatch(/importScripts/u)
  })
})

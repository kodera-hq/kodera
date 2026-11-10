import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { signWebhookPayload, verifyWebhookRequest } from '@kodera/extension-sdk'
import { signTestWebhook, verifyTestWebhook } from './webhookTester'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const secret = 'whsec_local_test_only_1234'
const timestamp = '1800000000'
const body = '{"message": "Bonjour ☀", "value": 42}'

it('produces SDK-compatible v1 signatures over the exact UTF-8 bytes', async () => {
  const signature = await signTestWebhook(secret, timestamp, body)
  expect(signature).toBe(signWebhookPayload(secret, timestamp, body))
  expect(
    verifyWebhookRequest({
      secret,
      rawBody: body,
      signatureHeader: signature,
      timestampHeader: timestamp,
      nowUnixSeconds: Number(timestamp),
    })
  ).toEqual({ message: 'Bonjour ☀', value: 42 })
  await expect(
    verifyTestWebhook(secret, timestamp, body, signature, Number(timestamp))
  ).resolves.toBeUndefined()
})

it('rejects changed bodies, secrets, malformed signatures, and stale timestamps', async () => {
  const signature = await signTestWebhook(secret, timestamp, body)
  await expect(
    verifyTestWebhook(secret, timestamp, body + ' ', signature, Number(timestamp))
  ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' })
  await expect(
    verifyTestWebhook(secret + 'x', timestamp, body, signature, Number(timestamp))
  ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' })
  await expect(
    verifyTestWebhook(secret, timestamp, body, 'v1=xyz', Number(timestamp))
  ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' })
  await expect(
    verifyTestWebhook(secret, timestamp, body, signature, Number(timestamp) + 301)
  ).rejects.toMatchObject({ code: 'TIMESTAMP_OUT_OF_RANGE' })
  await expect(
    verifyTestWebhook(secret, timestamp, body, signature, Number(timestamp) - 301)
  ).rejects.toMatchObject({ code: 'TIMESTAMP_OUT_OF_RANGE' })
})

it('validates secret length, canonical timestamp and signed JSON object', async () => {
  await expect(signTestWebhook('short', timestamp, body)).rejects.toMatchObject({
    code: 'INVALID_SECRET',
  })
  for (const invalid of ['01', '-1', '1e9', '9007199254740992']) {
    await expect(signTestWebhook(secret, invalid, body)).rejects.toMatchObject({
      code: 'INVALID_TIMESTAMP',
    })
  }
  for (const invalid of ['broken', 'null', '[]']) {
    const signature = await signTestWebhook(secret, timestamp, invalid)
    await expect(
      verifyTestWebhook(secret, timestamp, invalid, signature, Number(timestamp))
    ).rejects.toMatchObject({ code: 'INVALID_JSON' })
  }
})

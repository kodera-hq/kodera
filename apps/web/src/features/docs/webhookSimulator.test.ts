import { webcrypto, createHmac } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { signExampleWebhook, verifyExampleWebhook } from './webhookSimulator'
const example = {
  scheme: 'kodera' as const,
  secret: 'local-example-secret-only',
  payload: '{"type":"asset.ready","assetId":"demo-1"}',
  timestamp: '1700000000',
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
it('matches the SDK timestamp.rawBody transcript byte for byte', async () => {
  const expected =
    'v1=' +
    createHmac('sha256', example.secret)
      .update(`${example.timestamp}.${example.payload}`)
      .digest('hex')
  expect(await signExampleWebhook(example)).toBe(expected)
  expect(await verifyExampleWebhook({ ...example, signature: expected }, 1700000000)).toBe(true)
  expect(
    await verifyExampleWebhook(
      { ...example, payload: example.payload + ' ', signature: expected },
      1700000000
    )
  ).toBe(false)
})
it('separates native GitHub and the Kodera envelope', async () => {
  const github = { ...example, scheme: 'github' as const }
  const expected =
    'sha256=' + createHmac('sha256', example.secret).update(example.payload).digest('hex')
  expect(await signExampleWebhook(github)).toBe(expected)
  expect(await verifyExampleWebhook({ ...github, signature: expected }, 1700001000)).toBe(true)
  expect(await verifyExampleWebhook({ ...example, signature: expected }, 1700000000)).toBe(false)
})
it('checks canonical time and the inclusive SDK window without claiming replay persistence', async () => {
  const signature = await signExampleWebhook(example)
  expect(await verifyExampleWebhook({ ...example, signature }, 1700000300)).toBe(true)
  await expect(verifyExampleWebhook({ ...example, signature }, 1700000301)).rejects.toThrow(
    'EXPIRED'
  )
  await expect(signExampleWebhook({ ...example, timestamp: '01700000000' })).rejects.toThrow(
    'TIMESTAMP'
  )
})
it('refuses unbounded or malformed inputs before crypto', async () => {
  await expect(signExampleWebhook({ ...example, secret: 'short' })).rejects.toThrow('SECRET_BOUNDS')
  await expect(signExampleWebhook({ ...example, secret: 'é'.repeat(8) })).rejects.toThrow(
    'SECRET_BOUNDS'
  )
  await expect(signExampleWebhook({ ...example, payload: 'a'.repeat(65537) })).rejects.toThrow(
    'PAYLOAD_BOUNDS'
  )
  await expect(signExampleWebhook({ ...example, payload: '[]' })).rejects.toThrow('INVALID_PAYLOAD')
  await expect(signExampleWebhook({ ...example, payload: '{' })).rejects.toThrow('INVALID_PAYLOAD')
})

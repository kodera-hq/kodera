// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeSecurityCodes,
  createCrossSigningSession,
  VERIFICATION_VOCABULARY,
} from './cross-signing.worker'
import { base64 } from './security-encoding.worker'

const context = { organisationId: 'org-test', accountId: 'account-test', deviceId: 'device-a' }
const nonce = base64(new Uint8Array(32).fill(12))
const sessions: Awaited<ReturnType<typeof createCrossSigningSession>>[] = []
async function session(change = {}) {
  const s = await createCrossSigningSession({ ...context, ...change })
  sessions.push(s)
  return s
}
afterEach(() => {
  sessions.splice(0).forEach((s) => s.close())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('worker cross-signing', () => {
  it('holds non-extractable P-256 private keys and exposes only public identity', async () => {
    const original = crypto.subtle.generateKey.bind(crypto.subtle)
    let pair: CryptoKeyPair | undefined
    vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(
      async (...args: Parameters<typeof crypto.subtle.generateKey>) => {
        const result = await original(...args)
        pair = result as CryptoKeyPair
        return result
      }
    )
    const signer = await session()
    expect(pair!.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('pkcs8', pair!.privateKey)).rejects.toThrow()
    expect(Object.keys(signer.publicIdentity()).sort()).toEqual(['id', 'keyId', 'pub'])
  })
  it('signs canonical endorsements and verifies a pinned peer key and target', async () => {
    const a = await session(),
      b = await session({ deviceId: 'device-b' })
    const { id, pub } = b.publicIdentity(),
      target = { id, pub }
    const endorsement = await a.endorse(target)
    expect(JSON.parse(endorsement.statement)).toEqual([
      'kodera-device-endorsement',
      1,
      context.organisationId,
      context.accountId,
      a.publicIdentity().keyId,
      id,
      pub,
      expect.any(Number),
    ])
    expect(await b.verify({ endorsement, endorser: a.publicIdentity(), target })).toBe(true)
  })
  it('rejects tampered, noncanonical, expired, future, cross-principal and wrong-target statements', async () => {
    const a = await session(),
      b = await session({ deviceId: 'device-b' }),
      c = await session({ deviceId: 'device-c' })
    const { id, pub } = b.publicIdentity(),
      target = { id, pub },
      endorsement = await a.endorse(target)
    const verify = (e = endorsement, endorser = a.publicIdentity(), t = target) =>
      b.verify({ endorsement: e, endorser, target: t })
    for (const [at, value] of [
      [0, 'wrong-domain'],
      [1, 2],
      [2, 'wrong-org'],
      [3, 'wrong-account'],
      [4, 'wrong-key'],
      [5, 'wrong-device'],
      [6, c.publicIdentity().pub],
      [7, Date.now() - 600_001],
      [7, Date.now() + 10000],
    ]) {
      const statement = JSON.parse(endorsement.statement) as unknown[]
      statement[at as number] = value
      await expect(
        verify({ ...endorsement, statement: JSON.stringify(statement) })
      ).rejects.toThrow()
    }
    await expect(
      verify({ ...endorsement, statement: ' ' + endorsement.statement })
    ).rejects.toThrow()
    await expect(
      verify({ ...endorsement, signature: base64(new Uint8Array(64)) })
    ).rejects.toThrow()
    await expect(verify(endorsement, c.publicIdentity())).rejects.toThrow()
    await expect(
      verify(endorsement, a.publicIdentity(), { ...target, id: 'other' })
    ).rejects.toThrow()
    const wrongPrincipal = await session({ organisationId: 'other' })
    await expect(
      wrongPrincipal.verify({ endorsement, endorser: a.publicIdentity(), target })
    ).rejects.toThrow()
  })
  it('rejects self loops, same public key, accessor inputs and post-close work', async () => {
    const a = await session(),
      identity = a.publicIdentity()
    await expect(a.endorse({ id: identity.id, pub: base64(new Uint8Array(32)) })).rejects.toThrow()
    await expect(a.endorse({ id: 'different', pub: identity.pub })).rejects.toThrow()
    await expect(
      a.endorse({
        get id() {
          throw new Error('Getter invoked')
        },
        pub: identity.pub,
      })
    ).rejects.toThrow('Confidential crypto refused.')
    await expect(a.endorse({ id: 'different', pub: 'bad' })).rejects.toThrow()
    a.close()
    expect(() => a.publicIdentity()).toThrow()
  })
  it('is symmetric across device ordering with eight decimal groups and seven fixed symbols', async () => {
    const a = await session(),
      b = await session({ deviceId: 'device-b' })
    const deviceA = { id: a.publicIdentity().id, pub: a.publicIdentity().pub },
      deviceB = { id: b.publicIdentity().id, pub: b.publicIdentity().pub }
    const input = {
      organisationId: context.organisationId,
      accountId: context.accountId,
      deviceA,
      deviceB,
      sessionNonce: nonce,
    }
    const codes = await a.securityCodes(input)
    expect(codes).toEqual(await b.securityCodes({ ...input, deviceA: deviceB, deviceB: deviceA }))
    expect(codes.decimal).toHaveLength(8)
    codes.decimal.forEach((v) => expect(v).toMatch(/^\d{4}$/))
    expect(codes.symbols).toHaveLength(7)
    codes.symbols.forEach((v) => expect(VERIFICATION_VOCABULARY).toContain(v))
    expect(new Set(VERIFICATION_VOCABULARY).size).toBe(64)
    for (const change of [
      { organisationId: 'other' },
      { accountId: 'other' },
      { sessionNonce: base64(new Uint8Array(32).fill(5)) },
      { deviceB: { ...deviceB, id: 'other' } },
    ])
      expect(await computeSecurityCodes({ ...input, ...change })).not.toEqual(codes)
    for (const deviceB of [
      deviceA,
      { ...input.deviceB, id: deviceA.id },
      { ...input.deviceB, pub: deviceA.pub },
    ])
      await expect(computeSecurityCodes({ ...input, deviceB })).rejects.toThrow()
    await expect(computeSecurityCodes({ ...input, sessionNonce: '' })).rejects.toThrow()
    await expect(a.securityCodes({ ...input, accountId: 'other' })).rejects.toThrow()
  })
  it('keeps a fixed security-code vector across implementations', async () => {
    const codes = await computeSecurityCodes({
      organisationId: 'org',
      accountId: 'account',
      deviceA: { id: 'a', pub: base64(new Uint8Array(32).fill(1)) },
      deviceB: { id: 'b', pub: base64(new Uint8Array(32).fill(2)) },
      sessionNonce: nonce,
    })
    expect(codes).toEqual({
      decimal: ['5191', '7681', '6424', '7626', '7202', '9420', '2293', '7683'],
      symbols: ['piano', 'anchor', 'badger', 'mushroom', 'horse', 'mountain', 'rainbow'],
    })
  })
  it('refuses document-context imports', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})
    await expect(import('./cross-signing.worker')).rejects.toThrow()
    vi.resetModules()
  })
})

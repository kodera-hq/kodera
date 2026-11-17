import { base64, unbase64, verificationPrincipal } from './security-encoding.worker'
import { fields, need, text } from './crypto-session.worker-core'
import { hostSecurityWorker } from './security-rpc.worker'
import type { SecurityWorkerScope } from './security-rpc.worker'
import type {
  CrossSigningContext,
  Endorsement,
  PublicEndorser,
  SecurityCodes,
  VerificationDevice,
} from './cross-signing-client'

if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Cross-signing requires a worker.')
const encoder = new TextEncoder()
const MAX_AGE = 10 * 60_000
export const VERIFICATION_VOCABULARY = Object.freeze([
  'anchor',
  'apple',
  'arrow',
  'badger',
  'balloon',
  'beacon',
  'beetle',
  'bell',
  'bicycle',
  'bird',
  'book',
  'bridge',
  'butterfly',
  'cactus',
  'camera',
  'candle',
  'castle',
  'cat',
  'cherry',
  'cloud',
  'compass',
  'crab',
  'crown',
  'diamond',
  'dolphin',
  'drum',
  'eagle',
  'elephant',
  'feather',
  'fern',
  'fish',
  'flag',
  'flower',
  'fox',
  'frog',
  'giraffe',
  'globe',
  'guitar',
  'hammer',
  'hat',
  'heart',
  'horse',
  'island',
  'key',
  'kite',
  'ladder',
  'leaf',
  'lion',
  'moon',
  'mountain',
  'mushroom',
  'octopus',
  'owl',
  'panda',
  'pear',
  'penguin',
  'piano',
  'pineapple',
  'rabbit',
  'rainbow',
  'rocket',
  'sailboat',
  'star',
  'turtle',
])
function device(input: unknown): VerificationDevice {
  const d = fields(input, ['id', 'pub'])
  text(d.id)
  unbase64(d.pub, [32, 65])
  return Object.freeze({ id: d.id, pub: d.pub as string })
}
async function keyId(pub: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', unbase64(pub, [65]))))
}
export async function computeSecurityCodes(input: unknown): Promise<SecurityCodes> {
  const s = fields(input, ['organisationId', 'accountId', 'deviceA', 'deviceB', 'sessionNonce'])
  const principal = verificationPrincipal({
    organisationId: s.organisationId,
    accountId: s.accountId,
  })
  const a = device(s.deviceA),
    b = device(s.deviceB)
  for (const d of [a, b]) {
    const pub = unbase64(d.pub, [32, 65])
    need(pub.some((v) => v !== 0))
    if (pub.length === 65)
      await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'verify',
      ])
  }
  need(a.id !== b.id && a.pub !== b.pub)
  unbase64(s.sessionNonce, [32])
  const devices = [a, b].sort((left, right) => (left.id < right.id ? -1 : 1))
  const transcript = encoder.encode(
    JSON.stringify([
      'kodera-device-sas',
      1,
      principal.organisationId,
      principal.accountId,
      devices.map((d) => [d.id, d.pub]),
      s.sessionNonce,
    ])
  )
  const material = await crypto.subtle.importKey('raw', transcript, 'HKDF', false, ['deriveBits'])
  const derive = async (label: string, bits: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('kodera-device-sas-v1'),
          info: encoder.encode(label),
        },
        material,
        bits
      )
    )
  const digits = await derive('decimal', 2048),
    symbols = await derive('symbols', 56)
  try {
    const decimal: string[] = []
    for (let i = 0; i + 1 < digits.length && decimal.length < 8; i += 2) {
      const value = digits[i]! * 256 + digits[i + 1]!
      if (value < 60_000) decimal.push(String(value % 10_000).padStart(4, '0'))
    }
    need(decimal.length === 8)
    return Object.freeze({
      decimal: Object.freeze(decimal),
      symbols: Object.freeze(Array.from(symbols, (v) => VERIFICATION_VOCABULARY[v & 63]!)),
    })
  } finally {
    digits.fill(0)
    symbols.fill(0)
    transcript.fill(0)
  }
}
export async function createCrossSigningSession(input: unknown) {
  const c = fields(input, ['organisationId', 'accountId', 'deviceId'])
  const p = verificationPrincipal({ organisationId: c.organisationId, accountId: c.accountId })
  text(c.deviceId)
  const context: CrossSigningContext = Object.freeze({ ...p, deviceId: c.deviceId })
  let keys: CryptoKeyPair | undefined = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  )
  const pub = base64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  const identity: PublicEndorser = Object.freeze({
    id: context.deviceId,
    pub,
    keyId: await keyId(pub),
  })
  const alive = () => {
    need(keys)
  }
  const canonical = (target: VerificationDevice, issued: number, endorserId: string) =>
    JSON.stringify([
      'kodera-device-endorsement',
      1,
      context.organisationId,
      context.accountId,
      endorserId,
      target.id,
      target.pub,
      issued,
    ])
  const session = Object.freeze({
    publicIdentity: () => {
      alive()
      return identity
    },
    close: () => {
      keys = undefined
    },
    async endorse(input: unknown): Promise<Endorsement> {
      alive()
      const target = device(input)
      need(target.id !== identity.id && target.pub !== identity.pub)
      const statement = canonical(target, Date.now(), identity.keyId)
      const signature = base64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys!.privateKey,
            encoder.encode(statement)
          )
        )
      )
      alive()
      return Object.freeze({ statement, signature })
    },
    async verify(input: unknown): Promise<boolean> {
      alive()
      const v = fields(input, ['endorsement', 'endorser', 'target'])
      const e = fields(v.endorsement, ['statement', 'signature']),
        signer = fields(v.endorser, ['id', 'pub', 'keyId'])
      const target = device(v.target),
        endorser = device({ id: signer.id, pub: signer.pub })
      need(
        endorser.id !== target.id &&
          endorser.pub !== target.pub &&
          typeof e.statement === 'string' &&
          e.statement.length <= 2048
      )
      const raw: unknown = JSON.parse(e.statement)
      need(Array.isArray(raw) && raw.length === 8)
      const issued: unknown = raw[7],
        now = Date.now()
      need(
        typeof issued === 'number' &&
          Number.isSafeInteger(issued) &&
          issued >= 0 &&
          issued <= now &&
          now - issued <= MAX_AGE
      )
      const expectedId = await keyId(endorser.pub)
      need(signer.keyId === expectedId && e.statement === canonical(target, issued, expectedId))
      const key = await crypto.subtle.importKey(
        'raw',
        unbase64(endorser.pub, [65]),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      )
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        unbase64(e.signature, [64]),
        encoder.encode(e.statement)
      )
      alive()
      need(valid)
      return true
    },
    async securityCodes(input: unknown): Promise<SecurityCodes> {
      alive()
      const s = fields(input, ['organisationId', 'accountId', 'deviceA', 'deviceB', 'sessionNonce'])
      need(s.organisationId === context.organisationId && s.accountId === context.accountId)
      const a = device(s.deviceA),
        b = device(s.deviceB)
      need([a, b].some((d) => d.id === identity.id && d.pub === identity.pub))
      const result = await computeSecurityCodes(input)
      alive()
      return result
    },
  })
  return session
}
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  let session: Awaited<ReturnType<typeof createCrossSigningSession>> | undefined
  hostSecurityWorker(
    self as unknown as SecurityWorkerScope,
    async (context) => {
      session = await createCrossSigningSession(context)
      return async (operation, input) => {
        need(session)
        if (operation === 'identity') {
          need(input === null)
          return session.publicIdentity()
        }
        if (operation === 'endorse') return session.endorse(input)
        if (operation === 'verify') return session.verify(input)
        if (operation === 'sas') return session.securityCodes(input)
        throw new Error('Unknown security operation.')
      }
    },
    () => {
      session?.close()
    }
  )
}

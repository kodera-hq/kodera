import { copyBackupBytes } from './backup-bytes.worker'
import { fields, integer, need } from './crypto-session.worker-core'
import { base64, unbase64, verificationPrincipal } from './security-encoding.worker'
import { hostSecurityWorker } from './security-rpc.worker'
import type { SecurityWorkerScope } from './security-rpc.worker'
import type { BackupContext, SealedBackup } from './key-backup-client'

if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Key backup requires a worker.')
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true })
const LIMIT = 20 * 1024 * 1024
export const MIN_BACKUP_ITERATIONS = 600_000
function context(input: unknown): BackupContext {
  const value = fields(input, ['organisationId', 'accountId', 'backupEpoch'])
  const principal = verificationPrincipal({
    organisationId: value.organisationId,
    accountId: value.accountId,
  })
  integer(value.backupEpoch)
  need(value.backupEpoch > 0)
  return Object.freeze({ ...principal, backupEpoch: value.backupEpoch })
}
function iterations(value: unknown): asserts value is number {
  need(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_BACKUP_ITERATIONS &&
      value <= 2_000_000
  )
}
function passphrase(value: unknown): Uint8Array<ArrayBuffer> {
  need(typeof value === 'string' && value.length >= 12 && value.length <= 1024)
  return encoder.encode(value)
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('')
export async function formatRecoveryKey(key: Uint8Array<ArrayBuffer>): Promise<string> {
  need(key.length === 32)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key))
  try {
    return (hex(key) + hex(digest.subarray(0, 2))).match(/.{4}/g)!.join('-')
  } finally {
    digest.fill(0)
  }
}
export async function parseRecoveryKey(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  need(typeof value === 'string' && /^[0-9a-fA-F]{4}(?:-[0-9a-fA-F]{4}){16}$/.test(value))
  const compact = value.replaceAll('-', '').toLowerCase(),
    bytes = new Uint8Array(32)
  try {
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16)
    need((await formatRecoveryKey(bytes)) === value.toLowerCase())
    return bytes
  } catch (error) {
    bytes.fill(0)
    throw error
  }
}
async function aesKey(
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: aad },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
async function harden(
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  count: number
): Promise<Uint8Array<ArrayBuffer>> {
  iterations(count)
  const material = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-512', salt, iterations: count },
      material,
      256
    )
  )
}
export async function sealBackup(
  scope: BackupContext,
  input: Uint8Array,
  options: unknown
): Promise<SealedBackup> {
  const c = context(scope)
  let plaintext: Uint8Array<ArrayBuffer> | undefined,
    secret: Uint8Array<ArrayBuffer> | undefined,
    hardened: Uint8Array<ArrayBuffer> | undefined
  try {
    plaintext = copyBackupBytes(input, 1, LIMIT)
    need(options !== null && typeof options === 'object')
    const mode = Object.getOwnPropertyDescriptor(options, 'kind')
    need(mode && 'value' in mode)
    const o = fields(
      options,
      mode.value === 'recovery-key' ? ['kind'] : ['kind', 'passphrase', 'iterations']
    )
    need(o.kind === 'recovery-key' || o.kind === 'passphrase')
    const count = o.kind === 'passphrase' ? o.iterations : 0
    if (o.kind === 'passphrase') {
      iterations(count)
      secret = passphrase(o.passphrase)
    } else secret = crypto.getRandomValues(new Uint8Array(32))
    const salt = crypto.getRandomValues(new Uint8Array(16)),
      iv = crypto.getRandomValues(new Uint8Array(12))
    const aadFields = [
      'kodera-zk-key-backup',
      1,
      c.organisationId,
      c.accountId,
      c.backupEpoch,
      o.kind,
      count,
    ]
    const aad = encoder.encode(JSON.stringify(aadFields))
    hardened = o.kind === 'passphrase' ? await harden(secret, salt, count as number) : secret
    const key = await aesKey(hardened, salt, aad)
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        plaintext
      )
    )
    const header = encoder.encode(JSON.stringify([...aadFields, base64(salt), base64(iv)]))
    need(header.length <= 2048)
    const capsule = new Uint8Array(9 + header.length + encrypted.length)
    capsule.set(encoder.encode('KVKB1'))
    new DataView(capsule.buffer).setUint32(5, header.length)
    capsule.set(header, 9)
    capsule.set(encrypted, 9 + header.length)
    return {
      capsule,
      recoveryKey: o.kind === 'recovery-key' ? await formatRecoveryKey(secret) : null,
    }
  } finally {
    plaintext?.fill(0)
    secret?.fill(0)
    hardened?.fill(0)
  }
}
/** Worker-internal primitive. Only the vault port host may release its plaintext result. */
export async function openBackup(
  scope: BackupContext,
  input: Uint8Array,
  options: unknown
): Promise<Uint8Array<ArrayBuffer>> {
  const c = context(scope)
  let capsule: Uint8Array<ArrayBuffer> | undefined,
    secret: Uint8Array<ArrayBuffer> | undefined,
    hardened: Uint8Array<ArrayBuffer> | undefined,
    plaintext: Uint8Array<ArrayBuffer> | undefined
  try {
    capsule = copyBackupBytes(input, 26, LIMIT + 4096)
    need(decoder.decode(capsule.subarray(0, 5)) === 'KVKB1')
    const size = new DataView(capsule.buffer).getUint32(5)
    need(size > 0 && size <= 2048 && capsule.length >= 9 + size + 17)
    const encoded = decoder.decode(capsule.subarray(9, 9 + size)),
      raw: unknown = JSON.parse(encoded)
    need(Array.isArray(raw) && raw.length === 9 && JSON.stringify(raw) === encoded)
    need(
      raw[0] === 'kodera-zk-key-backup' &&
        raw[1] === 1 &&
        raw[2] === c.organisationId &&
        raw[3] === c.accountId &&
        raw[4] === c.backupEpoch
    )
    need(raw[5] === 'recovery-key' || raw[5] === 'passphrase')
    const o = fields(
      options,
      raw[5] === 'recovery-key' ? ['kind', 'recoveryKey'] : ['kind', 'passphrase']
    )
    need(o.kind === raw[5])
    const salt = unbase64(raw[7], [16]),
      iv = unbase64(raw[8], [12]),
      aad = encoder.encode(JSON.stringify(raw.slice(0, 7)))
    if (raw[5] === 'passphrase') {
      iterations(raw[6])
      secret = passphrase(o.passphrase)
      hardened = await harden(secret, salt, raw[6])
    } else {
      need(raw[6] === 0)
      secret = await parseRecoveryKey(o.recoveryKey)
      hardened = secret
    }
    const key = await aesKey(hardened, salt, aad)
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        capsule.subarray(9 + size)
      )
    )
    need(plaintext.length >= 1 && plaintext.length <= LIMIT)
    const result = plaintext
    plaintext = undefined
    return result
  } finally {
    capsule?.fill(0)
    secret?.fill(0)
    hardened?.fill(0)
    plaintext?.fill(0)
  }
}
export interface ParsedKvkb1Header {
  readonly organisationId: string
  readonly accountId: string
  readonly backupEpoch: number
  readonly kdfKind: 'recovery-key' | 'passphrase'
  readonly iterations: number
}
export function parseKvkb1EnvelopeHeader(input: Uint8Array): ParsedKvkb1Header {
  const capsule = copyBackupBytes(input, 42, LIMIT + 4096)
  try {
    need(decoder.decode(capsule.subarray(0, 5)) === 'KVKB1')
    const size = new DataView(capsule.buffer).getUint32(5)
    need(size > 0 && size <= 2048 && capsule.length >= 9 + size + 17)
    const encoded = decoder.decode(capsule.subarray(9, 9 + size)),
      raw: unknown = JSON.parse(encoded)
    need(Array.isArray(raw) && raw.length === 9 && JSON.stringify(raw) === encoded)
    need(raw[0] === 'kodera-zk-key-backup' && raw[1] === 1)
    const principal = verificationPrincipal({
      organisationId: raw[2],
      accountId: raw[3],
    })
    integer(raw[4])
    need(raw[4] > 0)
    need(raw[5] === 'recovery-key' || raw[5] === 'passphrase')
    if (raw[5] === 'recovery-key') need(raw[6] === 0)
    else iterations(raw[6])
    unbase64(raw[7], [16])
    unbase64(raw[8], [12])
    return Object.freeze({
      organisationId: principal.organisationId,
      accountId: principal.accountId,
      backupEpoch: raw[4],
      kdfKind: raw[5],
      iterations: raw[6],
    })
  } finally {
    capsule.fill(0)
  }
}
export function createBackupVaultBridge(port: MessagePort, scope: BackupContext) {
  const base = context(scope)
  let currentEpoch = base.backupEpoch
  let active = true,
    nextId = 0
  let waiting:
    | {
        id: number
        resolve: (bytes: Uint8Array<ArrayBuffer> | null) => void
        reject: (reason: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const close = () => {
    active = false
    port.close()
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('Vault unavailable.'))
      waiting = undefined
    }
  }
  port.onmessageerror = close
  port.onmessage = (event: MessageEvent<unknown>) => {
    let original: Uint8Array | undefined
    try {
      const descriptor =
        event.data && typeof event.data === 'object'
          ? Object.getOwnPropertyDescriptor(event.data, 'bytes')
          : undefined
      if (descriptor && 'value' in descriptor && descriptor.value instanceof Uint8Array)
        original = descriptor.value
      const v = fields(event.data, ['id', 'kind', 'bytes'])
      need(active && waiting && v.id === waiting.id && v.kind === 'vault-result')
      const bytes = v.bytes === null ? null : copyBackupBytes(v.bytes, 1, LIMIT)
      const item = waiting
      waiting = undefined
      clearTimeout(item.timer)
      item.resolve(bytes)
    } catch {
      close()
    } finally {
      original?.fill(0)
    }
  }
  port.start()
  const currentScope = (): BackupContext =>
    Object.freeze({ ...base, backupEpoch: currentEpoch })
  const exchange = (kind: 'read' | 'write', bytes: Uint8Array<ArrayBuffer> | null) =>
    new Promise<Uint8Array<ArrayBuffer> | null>((resolve, reject) => {
      need(active && !waiting)
      const id = ++nextId
      waiting = { id, resolve, reject, timer: setTimeout(close, 10_000) }
      try {
        port.postMessage(
          { kind, id, context: currentScope(), bytes },
          bytes ? [bytes.buffer] : []
        )
      } catch {
        close()
      }
    })
  return Object.freeze({
    close,
    advanceEpoch(input: unknown) {
      need(active)
      const v = fields(input, ['backupEpoch'])
      integer(v.backupEpoch)
      need(v.backupEpoch >= currentEpoch)
      currentEpoch = v.backupEpoch
      return currentEpoch
    },
    async seal(options: unknown) {
      const bytes = await exchange('read', null)
      need(bytes)
      try {
        const result = await sealBackup(currentScope(), bytes, options)
        need(active)
        return result
      } finally {
        bytes.fill(0)
      }
    },
    async restore(input: unknown) {
      const hasEpoch =
        input !== null &&
        typeof input === 'object' &&
        Object.prototype.hasOwnProperty.call(input, 'backupEpoch')
      const v = fields(input, hasEpoch ? ['capsule', 'options', 'backupEpoch'] : ['capsule', 'options'])
      if (hasEpoch) {
        integer(v.backupEpoch)
        need(v.backupEpoch >= currentEpoch)
        currentEpoch = v.backupEpoch
      }
      let bytes: Uint8Array<ArrayBuffer> | undefined
      try {
        bytes = await openBackup(currentScope(), v.capsule as Uint8Array, v.options)
        need(active)
        const result = await exchange('write', bytes)
        need(active && result === null)
        return true
      } finally {
        if (bytes?.byteLength) bytes.fill(0)
      }
    },
  })
}
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  let bridge: ReturnType<typeof createBackupVaultBridge> | undefined
  hostSecurityWorker(
    self as unknown as SecurityWorkerScope,
    async (scope, vaultPort) => {
      need(vaultPort)
      bridge = createBackupVaultBridge(vaultPort, context(scope))
      return async (operation, input) => {
        need(bridge)
        if (operation === 'seal') return bridge.seal(input)
        if (operation === 'restore') return bridge.restore(input)
        if (operation === 'advance-epoch') return bridge.advanceEpoch(input)
        throw new Error('Unknown backup operation.')
      }
    },
    () => {
      bridge?.close()
    },
    true
  )
}

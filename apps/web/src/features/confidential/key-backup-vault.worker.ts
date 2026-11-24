import { copyBackupBytes } from './backup-bytes.worker'
import { fields, integer, need, text } from './crypto-session.worker-core'
import { verificationPrincipal } from './security-encoding.worker'
import { hostSecurityWorker } from './security-rpc.worker'
import type { SecurityWorkerScope } from './security-rpc.worker'
import {
  ConfidentialStateError,
  initializeConfidentialState,
  openConfidentialState,
  LOCAL_STATE_LIMITS,
} from './local-state'
import type { ConfidentialStateStore, StateSnapshot, UniqueDeviceVault } from './local-state'
import type { BackupVaultContext } from './key-backup-vault-client'

if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Backup vault requires a worker.')
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true })
function vaultContext(input: unknown): BackupVaultContext {
  const c = fields(input, ['organisationId', 'accountId', 'backupEpoch', 'membershipId'])
  const p = verificationPrincipal({ organisationId: c.organisationId, accountId: c.accountId })
  text(c.membershipId)
  integer(c.backupEpoch)
  need(c.backupEpoch > 0)
  return Object.freeze({ ...p, membershipId: c.membershipId, backupEpoch: c.backupEpoch })
}
function clear(vault: UniqueDeviceVault | null | undefined): void {
  vault?.state.checkpoint.fill(0)
  for (const p of vault?.state.pendingSends ?? []) p.ciphertext.fill(0)
}
function validateCheckpoint(bytes: Uint8Array): void {
  need(
    bytes.length >= 92 &&
      bytes.length <= LOCAL_STATE_LIMITS.checkpointBytes &&
      decoder.decode(bytes.subarray(0, 4)) === 'KWE1' &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(52) ===
        bytes.length - 56 &&
      decoder.decode(bytes.subarray(56, 60)) === 'KDV1'
  )
}
export function encodeBackupVault(
  c: BackupVaultContext,
  vault: UniqueDeviceVault
): Uint8Array<ArrayBuffer> {
  need(
    vault.scope.kind === 'device-vault' &&
      vault.scope.ownerId === c.accountId &&
      vault.scope.organisationId === c.organisationId &&
      vault.scope.membershipId === c.membershipId &&
      vault.state.pendingSends.length <= 1
  )
  validateCheckpoint(vault.state.checkpoint)
  const pending = vault.state.pendingSends[0]
  const header = encoder.encode(
    JSON.stringify([
      'kodera-backup-vault',
      1,
      c.accountId,
      c.organisationId,
      c.membershipId,
      vault.scope.devicePublicKey,
      vault.generation,
      pending?.id ?? null,
    ])
  )
  const bytes = new Uint8Array(
    8 + header.length + vault.state.checkpoint.length + (pending?.ciphertext.length ?? 0)
  )
  new DataView(bytes.buffer).setUint32(0, header.length)
  new DataView(bytes.buffer).setUint32(4, vault.state.checkpoint.length)
  bytes.set(header, 8)
  bytes.set(vault.state.checkpoint, 8 + header.length)
  if (pending) bytes.set(pending.ciphertext, 8 + header.length + vault.state.checkpoint.length)
  return bytes
}
export function decodeBackupVault(c: BackupVaultContext, bytes: Uint8Array<ArrayBuffer>) {
  need(bytes.length >= 8)
  const view = new DataView(bytes.buffer),
    size = view.getUint32(0),
    checkpointLength = view.getUint32(4)
  need(
    size > 0 &&
      size <= 2048 &&
      checkpointLength >= 92 &&
      checkpointLength <= LOCAL_STATE_LIMITS.checkpointBytes &&
      8 + size + checkpointLength <= bytes.length
  )
  const encoded = decoder.decode(bytes.subarray(8, 8 + size)),
    raw: unknown = JSON.parse(encoded)
  need(
    Array.isArray(raw) &&
      raw.length === 8 &&
      JSON.stringify(raw) === encoded &&
      raw[0] === 'kodera-backup-vault' &&
      raw[1] === 1 &&
      raw[2] === c.accountId &&
      raw[3] === c.organisationId &&
      raw[4] === c.membershipId &&
      typeof raw[5] === 'string' &&
      /^[0-9a-f]{64}$/.test(raw[5]) &&
      typeof raw[6] === 'number' &&
      Number.isSafeInteger(raw[6]) &&
      raw[6] >= 1 &&
      raw[6] < Number.MAX_SAFE_INTEGER
  )
  const checkpoint = bytes.subarray(8 + size, 8 + size + checkpointLength),
    ciphertext = bytes.subarray(8 + size + checkpointLength)
  validateCheckpoint(checkpoint)
  need(
    (raw[7] === null && ciphertext.length === 0 && raw[6] === 1) ||
      (typeof raw[7] === 'string' &&
        /^[0-9a-f-]{36}$/.test(raw[7]) &&
        ciphertext.length >= 8 &&
        ciphertext.length <= 65536 &&
        raw[6] > 1)
  )
  const snapshot: StateSnapshot = {
    generation: raw[6],
    checkpoint,
    pendingSends: raw[7] === null ? [] : [{ id: raw[7] as string, ciphertext }],
  }
  return {
    scope: {
      ownerId: c.accountId,
      organisationId: c.organisationId,
      membershipId: c.membershipId,
      devicePublicKey: raw[5],
      kind: 'device-vault' as const,
    },
    snapshot,
  }
}
export function hostBackupVault(port: MessagePort, input: unknown) {
  const c = vaultContext(input),
    deviceContext = {
      ownerId: c.accountId,
      organisationId: c.organisationId,
      membershipId: c.membershipId,
    }
  let store: ConfidentialStateStore | undefined,
    active = true,
    busy = false,
    lastId = 0,
    currentEpoch = c.backupEpoch
  const alive = () => {
    need(active)
  }
  const close = () => {
    active = false
    store?.close()
    port.close()
  }
  async function open(initialize: boolean): Promise<ConfidentialStateStore> {
    alive()
    if (!store) {
      const opened = await (initialize
        ? initializeConfidentialState(c.accountId)
        : openConfidentialState(c.accountId))
      if (!active) {
        opened.close()
        throw new Error('Vault closed.')
      }
      store = opened
    }
    return store
  }
  port.onmessageerror = close
  port.onmessage = (event: MessageEvent<unknown>) => {
    let original: Uint8Array | undefined
    void (async () => {
      let vault: UniqueDeviceVault | null | undefined, bytes: Uint8Array<ArrayBuffer> | undefined
      try {
        const descriptor =
          event.data && typeof event.data === 'object'
            ? Object.getOwnPropertyDescriptor(event.data, 'bytes')
            : undefined
        if (descriptor && 'value' in descriptor && descriptor.value instanceof Uint8Array)
          original = descriptor.value
        const request = fields(event.data, ['kind', 'id', 'context', 'bytes'])
        need(
          active &&
            !busy &&
            typeof request.id === 'number' &&
            Number.isSafeInteger(request.id) &&
            request.id > lastId
        )
        const scope = fields(request.context, ['organisationId', 'accountId', 'backupEpoch'])
        integer(scope.backupEpoch)
        need(
          scope.organisationId === c.organisationId &&
            scope.accountId === c.accountId &&
            scope.backupEpoch >= currentEpoch
        )
        currentEpoch = scope.backupEpoch
        lastId = request.id
        busy = true
        if (request.kind === 'read') {
          need(request.bytes === null)
          vault = await (await open(false)).readUniqueDeviceVault(deviceContext)
          alive()
          need(vault)
          bytes = encodeBackupVault(c, vault)
          alive()
          port.postMessage({ kind: 'vault-result', id: request.id, bytes }, [bytes.buffer])
        } else {
          need(request.kind === 'write')
          bytes = copyBackupBytes(request.bytes, 1, 20 * 1024 * 1024)
          original?.fill(0)
          const restored = decodeBackupVault(c, bytes)
          await (await open(true)).restoreUniqueDeviceVault(restored.scope, restored.snapshot)
          alive()
          port.postMessage({ kind: 'vault-result', id: request.id, bytes: null })
        }
      } catch {
        close()
      } finally {
        if (bytes?.byteLength) bytes.fill(0)
        original?.fill(0)
        clear(vault)
        busy = false
      }
    })()
  }
  port.start()
  return Object.freeze({
    close,
    async status() {
      let vault: UniqueDeviceVault | null | undefined
      try {
        vault = await (await open(false)).readUniqueDeviceVault(deviceContext)
        alive()
        return { available: vault !== null, devicePublicKey: vault?.scope.devicePublicKey ?? null }
      } catch (error) {
        alive()
        if (error instanceof ConfidentialStateError && error.code === 'not-initialized')
          return { available: false, devicePublicKey: null }
        throw error
      } finally {
        clear(vault)
      }
    },
  })
}
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  let host: ReturnType<typeof hostBackupVault> | undefined
  hostSecurityWorker(
    self as unknown as SecurityWorkerScope,
    async (context, vaultPort) => {
      need(vaultPort)
      host = hostBackupVault(vaultPort, context)
      return async (operation, input) => {
        need(host && operation === 'status' && input === null)
        return host.status()
      }
    },
    () => {
      host?.close()
    },
    true
  )
}

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeBackupVault, encodeBackupVault, hostBackupVault } from './key-backup-vault.worker'
import type { UniqueDeviceVault } from './local-state'
import type * as LocalState from './local-state'

const storage = vi.hoisted(() => ({
  readUniqueDeviceVault: vi.fn(),
  restoreUniqueDeviceVault: vi.fn(),
  close: vi.fn(),
}))
vi.mock('./local-state', async (original) => ({
  ...(await original<typeof LocalState>()),
  openConfidentialState: vi.fn(async () => storage),
  initializeConfidentialState: vi.fn(async () => storage),
}))
const context = {
  accountId: '01950000-0000-7000-8000-000000000001',
  organisationId: '01950000-0000-7000-8000-000000000002',
  membershipId: '01950000-0000-7000-8000-000000000003',
  backupEpoch: 1,
}
function vault(): UniqueDeviceVault {
  const checkpoint = new Uint8Array(100)
  checkpoint.set(new TextEncoder().encode('KWE1'))
  checkpoint.set(new TextEncoder().encode('KDV1'), 56)
  new DataView(checkpoint.buffer).setUint32(52, checkpoint.length - 56)
  return {
    scope: {
      ownerId: context.accountId,
      organisationId: context.organisationId,
      membershipId: context.membershipId,
      kind: 'device-vault',
      devicePublicKey: '41'.repeat(32),
    },
    generation: 2,
    state: {
      checkpoint,
      pendingSends: [
        { id: '01950000-0000-7000-8000-000000000004', ciphertext: new Uint8Array(16).fill(7) },
      ],
    },
  }
}
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe('worker archive vault', () => {
  it('encodes checkpoint, wrapping seed, pending sends and generation without losing context', () => {
    const original = vault(),
      decoded = decodeBackupVault(context, encodeBackupVault(context, original))
    expect(decoded.scope).toEqual(original.scope)
    expect(decoded.snapshot).toEqual({ ...original.state, generation: original.generation })
    for (const change of [
      { accountId: 'wrong' },
      { organisationId: 'wrong' },
      { membershipId: 'wrong' },
    ])
      expect(() =>
        decodeBackupVault({ ...context, ...change }, encodeBackupVault(context, original))
      ).toThrow()
    const encoded = encodeBackupVault(context, original)
    expect(() => decodeBackupVault(context, encoded.subarray(0, 20))).toThrow()
    const broken = vault()
    broken.state.checkpoint[0] = 0
    expect(() => encodeBackupVault(context, broken)).toThrow()
  })
  it('transfers only to the backup port and clears store snapshots', async () => {
    const channel = new MessageChannel(),
      original = vault(),
      expected = encodeBackupVault(context, original)
    storage.readUniqueDeviceVault.mockResolvedValue(original)
    const host = hostBackupVault(channel.port2, context)
    try {
      const reply = new Promise<{ bytes: Uint8Array }>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data as { bytes: Uint8Array })
      })
      const { membershipId: _, ...publicContext } = context
      channel.port1.postMessage({ kind: 'read', id: 1, context: publicContext, bytes: null })
      expect((await reply).bytes).toEqual(expected)
      expect(original.state.checkpoint.every((v) => v === 0)).toBe(true)
      expect(original.state.pendingSends[0]!.ciphertext.every((v) => v === 0)).toBe(true)
    } finally {
      host.close()
      channel.port1.close()
    }
  })
  it('restores only through the store absence-checked restore method and acknowledges no bytes', async () => {
    const channel = new MessageChannel(),
      host = hostBackupVault(channel.port2, context),
      bytes = encodeBackupVault(context, vault())
    storage.restoreUniqueDeviceVault.mockResolvedValue(2)
    try {
      const reply = new Promise<unknown>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data)
      })
      const { membershipId: _, ...publicContext } = context
      channel.port1.postMessage({ kind: 'write', id: 1, context: publicContext, bytes }, [
        bytes.buffer,
      ])
      expect(bytes.byteLength).toBe(0)
      expect(await reply).toEqual({ kind: 'vault-result', id: 1, bytes: null })
      expect(storage.restoreUniqueDeviceVault).toHaveBeenCalledTimes(1)
      const captured = storage.restoreUniqueDeviceVault.mock.calls[0]![1] as {
        checkpoint: Uint8Array
      }
      expect(captured.checkpoint.every((v) => v === 0)).toBe(true)
    } finally {
      host.close()
      channel.port1.close()
    }
  })
  it('refuses document-context imports', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})
    await expect(import('./key-backup-vault.worker')).rejects.toThrow()
    vi.resetModules()
  })
})

// @vitest-environment node
import { copyBackupBytes } from './backup-bytes.worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBackupVaultBridge,
  formatRecoveryKey,
  openBackup,
  parseKvkb1EnvelopeHeader,
  parseRecoveryKey,
  sealBackup,
} from './key-backup.worker'

const context = { organisationId: 'org-test', accountId: 'account-test', backupEpoch: 3 }
const plaintext = () => new TextEncoder().encode('Private vault and epoch secret sentinel')
const recoveryMode = { kind: 'recovery-key' }
const passphraseMode = {
  kind: 'passphrase',
  passphrase: 'a strong test recovery passphrase',
  iterations: 600_000,
}
const credentials = (recoveryKey: string | null) =>
  recoveryKey
    ? { kind: 'recovery-key', recoveryKey }
    : { kind: 'passphrase', passphrase: passphraseMode.passphrase }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function header(capsule: Uint8Array): unknown[] {
  const size = new DataView(capsule.buffer).getUint32(5)
  return JSON.parse(new TextDecoder().decode(capsule.subarray(9, 9 + size))) as unknown[]
}
function replaceHeader(capsule: Uint8Array, raw: unknown[]): Uint8Array<ArrayBuffer> {
  const size = new DataView(capsule.buffer).getUint32(5),
    encoded = new TextEncoder().encode(JSON.stringify(raw))
  const output = new Uint8Array(9 + encoded.length + capsule.length - 9 - size)
  output.set(capsule.subarray(0, 5))
  new DataView(output.buffer).setUint32(5, encoded.length)
  output.set(encoded, 9)
  output.set(capsule.subarray(9 + size), 9 + encoded.length)
  return output
}

describe('worker zero-knowledge backup', () => {
  it.each([recoveryMode, passphraseMode])(
    'round-trips with authenticated $kind capsules and non-extractable AES keys',
    async (mode) => {
      const derive = vi.spyOn(crypto.subtle, 'deriveKey')
      const original = plaintext(),
        result = await sealBackup(context, original, mode)
      expect(new TextDecoder().decode(result.capsule.subarray(0, 5))).toBe('KVKB1')
      expect(new TextDecoder().decode(result.capsule)).not.toContain('Private vault')
      expect(await openBackup(context, result.capsule, credentials(result.recoveryKey))).toEqual(
        original
      )
      expect(original).toEqual(plaintext())
      for (const call of derive.mock.results) {
        const key = await (call.value as Promise<CryptoKey>)
        expect(key.extractable).toBe(false)
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
      }
      if (result.recoveryKey)
        expect(result.recoveryKey).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){16}$/)
    }
  )
  it('validates the checksum before any KDF or decrypt and rejects malformed keys', async () => {
    const result = await sealBackup(context, plaintext(), recoveryMode)
    const derive = vi.spyOn(crypto.subtle, 'deriveKey'),
      decrypt = vi.spyOn(crypto.subtle, 'decrypt')
    const key = result.recoveryKey!,
      bad = (key[0] === '0' ? '1' : '0') + key.slice(1)
    await expect(
      openBackup(context, result.capsule, { kind: 'recovery-key', recoveryKey: bad })
    ).rejects.toThrow()
    expect(derive).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    for (const input of ['', key.slice(1), 'z'.repeat(84), key.replaceAll('-', '')])
      await expect(parseRecoveryKey(input)).rejects.toThrow()
    expect(await formatRecoveryKey(await parseRecoveryKey(key.toUpperCase()))).toBe(key)
  })
  it('enforces PBKDF2 SHA-512 iteration bounds for sealing and capsule-controlled opening', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits')
    for (const iterations of [0, 599_999, 2_000_001, NaN, 600_000.5])
      await expect(
        sealBackup(context, plaintext(), { ...passphraseMode, iterations })
      ).rejects.toThrow()
    expect(derive).not.toHaveBeenCalled()
    const result = await sealBackup(context, plaintext(), passphraseMode)
    expect(derive.mock.calls[0]![0]).toMatchObject({
      name: 'PBKDF2',
      hash: 'SHA-512',
      iterations: 600_000,
    })
    const raw = header(result.capsule)
    raw[6] = 599_999
    derive.mockClear()
    await expect(
      openBackup(context, replaceHeader(result.capsule, raw), credentials(null))
    ).rejects.toThrow()
    expect(derive).not.toHaveBeenCalled()
    await expect(
      sealBackup(context, plaintext(), { ...passphraseMode, passphrase: 'short' })
    ).rejects.toThrow()
  })
  it('rejects wrong principal, epoch, credentials, AAD, salt, IV, tag and framing', async () => {
    const result = await sealBackup(context, plaintext(), recoveryMode),
      options = credentials(result.recoveryKey)
    for (const change of [{ organisationId: 'wrong' }, { accountId: 'wrong' }, { backupEpoch: 4 }])
      await expect(openBackup({ ...context, ...change }, result.capsule, options)).rejects.toThrow()
    const wrongKey = await formatRecoveryKey(new Uint8Array(32).fill(5))
    await expect(openBackup(context, result.capsule, credentials(wrongKey))).rejects.toThrow()
    for (const offset of [0, 5, result.capsule.length - 1]) {
      const changed = result.capsule.slice()
      changed[offset]! ^= 1
      await expect(openBackup(context, changed, options)).rejects.toThrow()
    }
    for (const at of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const raw = header(result.capsule)
      raw[at] = at >= 7 ? String(raw[at]).replace(/^./, (v) => (v === 'A' ? 'B' : 'A')) : 'wrong'
      await expect(
        openBackup(context, replaceHeader(result.capsule, raw), options)
      ).rejects.toThrow()
    }
    await expect(openBackup(context, result.capsule.subarray(0, 20), options)).rejects.toThrow()
    const pass = await sealBackup(context, plaintext(), passphraseMode)
    await expect(
      openBackup(context, pass.capsule, {
        kind: 'passphrase',
        passphrase: 'wrong recovery passphrase',
      })
    ).rejects.toThrow()
  })
  it('randomizes salt, IV, recovery key and ciphertext for repeated backups', async () => {
    const a = await sealBackup(context, plaintext(), recoveryMode),
      b = await sealBackup(context, plaintext(), recoveryMode)
    expect(a.recoveryKey).not.toBe(b.recoveryKey)
    expect(a.capsule).not.toEqual(b.capsule)
    expect(header(a.capsule).slice(7)).not.toEqual(header(b.capsule).slice(7))
  })
  it('clears owned plaintext and secret byte arguments after success and cryptographic failure', async () => {
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt'),
      imported = vi.spyOn(crypto.subtle, 'importKey')
    await sealBackup(context, plaintext(), recoveryMode)
    const bytes = encrypt.mock.calls[0]![2] as Uint8Array
    expect(bytes.every((v) => v === 0)).toBe(true)
    for (const call of imported.mock.calls)
      if (call[1] instanceof Uint8Array) expect(call[1].every((v) => v === 0)).toBe(true)
    encrypt.mockRejectedValueOnce(new Error('forced failure'))
    await expect(sealBackup(context, plaintext(), recoveryMode)).rejects.toThrow()
    expect((encrypt.mock.calls[1]![2] as Uint8Array).every((v) => v === 0)).toBe(true)
  })
  it('routes plaintext exclusively over the vault port and returns only sealed control results', async () => {
    const channel = new MessageChannel(),
      requests: unknown[] = [],
      restored: Uint8Array[] = []
    channel.port1.onmessage = (event) => {
      const r = event.data as { kind: string; id: number; bytes: Uint8Array | null }
      requests.push(r)
      if (r.kind === 'read') {
        const bytes = plaintext()
        channel.port1.postMessage({ kind: 'vault-result', id: r.id, bytes }, [bytes.buffer])
        expect(bytes.byteLength).toBe(0)
      } else {
        restored.push(r.bytes!.slice())
        r.bytes!.fill(0)
        channel.port1.postMessage({ kind: 'vault-result', id: r.id, bytes: null })
      }
    }
    channel.port1.start()
    const bridge = createBackupVaultBridge(channel.port2, context)
    try {
      const sealed = await bridge.seal(recoveryMode)
      expect(Object.keys(sealed).sort()).toEqual(['capsule', 'recoveryKey'])
      expect(
        await bridge.restore({ capsule: sealed.capsule, options: credentials(sealed.recoveryKey) })
      ).toBe(true)
      expect(restored).toEqual([plaintext()])
      expect(requests).toHaveLength(2)
    } finally {
      bridge.close()
      channel.port1.close()
    }
  })
  it('copies large vault views without enumerating indices and rejects unsafe storage', () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(7)
    const keys = vi.spyOn(Reflect, 'ownKeys')
    expect(copyBackupBytes(bytes, 1, bytes.length)).toEqual(bytes)
    expect(keys).not.toHaveBeenCalled()
    expect(() => copyBackupBytes(bytes, 1, 100)).toThrow()
    if (typeof SharedArrayBuffer !== 'undefined')
      expect(() => copyBackupBytes(new Uint8Array(new SharedArrayBuffer(32)), 1, 100)).toThrow()
    const accessor = plaintext()
    Object.defineProperty(accessor, 'buffer', {
      get: () => {
        throw new Error('Getter invoked')
      },
    })
    expect(() => copyBackupBytes(accessor, 1, 100)).toThrow('Confidential crypto refused.')
  })
  it('discards decrypted plaintext if the bridge closes during crypto', async () => {
    const sealed = await sealBackup(context, plaintext(), recoveryMode)
    const channel = new MessageChannel(),
      bridge = createBackupVaultBridge(channel.port2, context)
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    let release!: () => void, captured: ArrayBuffer | undefined
    const entered = new Promise<void>((resolve) => {
      vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
        captured = await decrypt(...args)
        resolve()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return captured
      })
    })
    const restoring = bridge.restore({
      capsule: sealed.capsule,
      options: credentials(sealed.recoveryKey),
    })
    await entered
    bridge.close()
    release()
    await expect(restoring).rejects.toThrow()
    expect(new Uint8Array(captured!).every((v) => v === 0)).toBe(true)
    channel.port1.close()
  })
  it('rejects extra control fields, closed bridges and document-context imports', async () => {
    const channel = new MessageChannel(),
      bridge = createBackupVaultBridge(channel.port2, context)
    await expect(
      bridge.restore({ capsule: new Uint8Array(30), options: recoveryMode, plaintext: plaintext() })
    ).rejects.toThrow()
    bridge.close()
    channel.port1.close()
    await expect(bridge.seal(recoveryMode)).rejects.toThrow()
    vi.resetModules()
    vi.stubGlobal('window', {})
    await expect(import('./key-backup.worker')).rejects.toThrow()
    vi.resetModules()
  })
  it('parses outer KVKB1 headers and enforces monotonic epoch advancement on bridge', async () => {
    const sealed = await sealBackup(context, plaintext(), recoveryMode)
    expect(parseKvkb1EnvelopeHeader(sealed.capsule)).toEqual({
      organisationId: context.organisationId,
      accountId: context.accountId,
      backupEpoch: 3,
      kdfKind: 'recovery-key',
      iterations: 0,
    })
    const channel = new MessageChannel()
    channel.port1.onmessage = (event) => {
      const r = event.data as { kind: string; id: number; context: { backupEpoch: number } }
      if (r.kind === 'read') {
        const bytes = plaintext()
        channel.port1.postMessage({ kind: 'vault-result', id: r.id, bytes }, [bytes.buffer])
      }
    }
    channel.port1.start()
    const bridge = createBackupVaultBridge(channel.port2, context)
    try {
      expect(() => bridge.advanceEpoch({ backupEpoch: 2 })).toThrow()
      expect(bridge.advanceEpoch({ backupEpoch: 4 })).toBe(4)
      const rotated = await bridge.seal(recoveryMode)
      expect(parseKvkb1EnvelopeHeader(rotated.capsule).backupEpoch).toBe(4)
    } finally {
      bridge.close()
      channel.port1.close()
    }
  })
})

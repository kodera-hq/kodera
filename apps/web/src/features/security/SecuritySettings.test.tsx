import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { ensureNamespaces } from '../../i18n'
import { clearLocalSessionStorage } from '../../auth/localSession'
import SecuritySettings from './SecuritySettings'

const mocks = vi.hoisted(() => ({
  crossClose: vi.fn(),
  backupClose: vi.fn(),
  vaultClose: vi.fn(),
  available: true,
  identity: vi.fn(),
  codes: vi.fn(),
  endorse: vi.fn(),
  verify: vi.fn(),
  seal: vi.fn(),
  restore: vi.fn(),
  advanceEpoch: vi.fn(),
  getRemote: vi.fn(),
  publishRemote: vi.fn(),
  discardRemote: vi.fn(),
  stamp: {},
  listeners: new Set<() => void>(),
}))
vi.mock('../../auth/AuthProvider', () => {
  const lifetime = {
    getRetirementStamp: () => mocks.stamp,
    hasUsableCredential: () => true,
    subscribe: (fn: () => void) => {
      mocks.listeners.add(fn)
      return () => mocks.listeners.delete(fn)
    },
  }
  return { useAuthLifetime: () => lifetime }
})
vi.mock('../confidential/cross-signing-client', () => ({
  createCrossSigningClient: () => ({
    close: mocks.crossClose,
    publicIdentity: mocks.identity,
    securityCodes: mocks.codes,
    endorse: mocks.endorse,
    verify: mocks.verify,
  }),
}))
vi.mock('../confidential/key-backup-client', () => ({
  createKeyBackupClient: () => ({
    close: mocks.backupClose,
    seal: mocks.seal,
    restore: mocks.restore,
    advanceEpoch: mocks.advanceEpoch,
  }),
}))
vi.mock('../confidential/key-backup-http', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getConfidentialKeyBackup: (...args: unknown[]) => mocks.getRemote(...args),
    publishConfidentialKeyBackup: (...args: unknown[]) => mocks.publishRemote(...args),
    discardConfidentialKeyBackup: (...args: unknown[]) => mocks.discardRemote(...args),
  }
})
vi.mock('../confidential/key-backup-vault-client', () => ({
  createBackupVaultClient: () => ({
    close: mocks.vaultClose,
    vaultPort: {},
    status: async () => ({ available: mocks.available, devicePublicKey: null }),
  }),
}))
const props = { organisationId: 'org-test', accountId: 'account-test', membershipId: 'member-test' }
const decimal = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '7890']
async function start() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Start local security session' }))
  await screen.findByLabelText('This session’s public descriptor')
  return user
}
beforeEach(async () => {
  await i18n.changeLanguage('en')
  await ensureNamespaces(['security'])
  mocks.available = true
  mocks.stamp = {}
  mocks.listeners.clear()
  mocks.identity.mockResolvedValue({ id: 'local', pub: 'local-public', keyId: 'key-id' })
  mocks.codes.mockResolvedValue({
    decimal,
    symbols: ['apple', 'bird', 'cat', 'cloud', 'fish', 'leaf', 'star'],
  })
  mocks.endorse.mockResolvedValue({ statement: 'public-statement', signature: 'public-signature' })
  mocks.verify.mockResolvedValue(true)
  mocks.seal.mockResolvedValue({
    capsule: new Uint8Array(48).fill(7),
    recoveryKey: 'one-time-recovery-key',
  })
  mocks.restore.mockResolvedValue(true)
  mocks.advanceEpoch.mockImplementation(async (epoch: number) => epoch)
  mocks.getRemote.mockRejectedValue(new Error('offline'))
  mocks.publishRemote.mockResolvedValue({
    backupEpoch: 1,
    kdfKind: 'recovery-key',
    iterations: 0,
    capsuleSha256: 'a'.repeat(64),
    sourceDeviceId: '01950000-0000-7000-8000-000000000001',
    publishedAt: '2026-11-24T12:00:00Z',
  })
  mocks.discardRemote.mockResolvedValue({ nextBackupEpoch: 2 })
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:sealed-backup')
      static override revokeObjectURL = vi.fn()
    }
  )
})
afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('fr')
})

describe('local security settings', () => {
  it('explains local scope, server storage limitations and full comparison without auto-verification', async () => {
    const { container } = render(<SecuritySettings {...props} />)
    expect(
      screen.getByText(
        /Server key-backup storage and durable account cross-signing are not available/
      )
    ).toBeInTheDocument()
    const user = await start()
    expect(mocks.endorse).not.toHaveBeenCalled()
    const field = screen.getByLabelText('Other device’s public descriptor (JSON)')
    await user.clear(field)
    await user.click(field)
    await user.paste('{"id":"peer","pub":"peer-public","keyId":"peer-key"}')
    await user.click(screen.getByRole('button', { name: 'Calculate security codes' }))
    expect(await screen.findByLabelText('Eight security code groups')).toHaveTextContent(
      decimal.join(' ')
    )
    const endorse = screen.getByRole('button', { name: 'Codes match — sign local endorsement' })
    expect(endorse).toBeDisabled()
    await user.type(
      screen.getByLabelText('Enter the other device’s eight groups, separated by spaces'),
      decimal.join(' ')
    )
    await user.click(endorse)
    expect(mocks.endorse).toHaveBeenCalledWith({ id: 'peer', pub: 'peer-public' })
    expect(await screen.findByLabelText('Public endorsement to share (JSON)')).toHaveValue(
      JSON.stringify({ statement: 'public-statement', signature: 'public-signature' })
    )
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })
  it('displays recovery once, gates archive download, and clears the UI and workers on sign-out', async () => {
    render(<SecuritySettings {...props} />)
    const user = await start()
    await user.click(screen.getByRole('button', { name: 'Create encrypted archive' }))
    expect(await screen.findByLabelText('One-time recovery key')).toHaveValue(
      'one-time-recovery-key'
    )
    expect(
      screen.queryByRole('link', { name: 'Download encrypted .kvkb archive' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'I saved the recovery key separately' }))
    expect(screen.getByRole('link', { name: 'Download encrypted .kvkb archive' })).toHaveAttribute(
      'download',
      'kodera-key-backup.kvkb'
    )
    act(() => clearLocalSessionStorage())
    expect(screen.queryByLabelText('One-time recovery key')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Download encrypted .kvkb archive' })
    ).not.toBeInTheDocument()
    expect(mocks.crossClose).toHaveBeenCalled()
    expect(mocks.backupClose).toHaveBeenCalled()
    expect(mocks.vaultClose).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sealed-backup')
  })
  it('imports only sealed files into an empty device slot and reports local restore limits', async () => {
    mocks.available = false
    render(<SecuritySettings {...props} />)
    const user = await start()
    expect(screen.getByRole('button', { name: 'Create encrypted archive' })).toBeDisabled()
    const file = new File([new Uint8Array([75, 86, 75, 66, 49])], 'archive.kvkb')
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([75, 86, 75, 66, 49]).buffer,
    })
    await user.upload(screen.getByLabelText('Choose encrypted .kvkb archive'), file)
    await user.type(
      screen.getByLabelText('Archive recovery key, including checksum'),
      'saved-recovery-key'
    )
    await user.click(screen.getByRole('button', { name: 'Restore archive locally' }))
    expect(mocks.restore).toHaveBeenCalledWith(new Uint8Array([75, 86, 75, 66, 49]), {
      kind: 'recovery-key',
      recoveryKey: 'saved-recovery-key',
    })
    expect(await screen.findByText(/Archive restored locally/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore archive locally' })).toBeDisabled()
  })
  it('discards a late recovery result after credential retirement', async () => {
    let release!: (value: unknown) => void
    mocks.seal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render(<SecuritySettings {...props} />)
    const user = await start()
    await user.click(screen.getByRole('button', { name: 'Create encrypted archive' }))
    act(() => {
      mocks.stamp = {}
      mocks.listeners.forEach((fn) => fn())
    })
    await act(async () => release({ capsule: new Uint8Array([1]), recoveryKey: 'late-secret' }))
    expect(screen.queryByDisplayValue('late-secret')).not.toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('renders a content-fit session button and a clear 2FA link card (issue 221)', () => {
    render(<SecuritySettings {...props} org="community" />)
    const startBtn = screen.getByRole('button', { name: /Start local security session/i })
    expect(startBtn.className).toContain('w-fit')
    expect(startBtn.className).toContain('self-start')
    const mfaLink = screen.getByTestId('security-mfa-link')
    expect(mfaLink).toHaveAttribute('href', '/community/security/mfa')
  })
  it('publishes sealed KVKB1 backup to server, restores on fresh device, and discards with monotonic epoch', async () => {
    const remoteBytes = new Uint8Array(48)
    remoteBytes.set([0x4b, 0x56, 0x4b, 0x42, 0x31])
    mocks.getRemote.mockResolvedValueOnce({ status: 'absent', nextBackupEpoch: 1 })
    const signer = vi.fn(async ({ backupEpoch, capsule }: { backupEpoch: number; capsule: string }) => ({
      deviceId: '01950000-0000-7000-8000-000000000001',
      backupEpoch,
      capsule,
      signature: 'B'.repeat(88),
    }))
    const { unmount } = render(<SecuritySettings {...props} deviceSigner={signer} />)
    const user = await start()
    await user.click(screen.getByRole('button', { name: 'Create encrypted archive' }))
    await user.click(screen.getByRole('checkbox', { name: 'I saved the recovery key separately' }))
    await user.click(screen.getByRole('button', { name: 'Publish sealed backup to server' }))
    expect(signer).toHaveBeenCalledWith(expect.objectContaining({ backupEpoch: 1 }))
    expect(mocks.publishRemote).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/Opaque KVKB1 archive published to server at epoch 1/)).toBeInTheDocument()
    expect(mocks.advanceEpoch).toHaveBeenCalledWith(2)

    await user.click(screen.getByRole('button', { name: 'Discard server backup' }))
    expect(mocks.discardRemote).toHaveBeenCalledWith('org-test')
    expect(await screen.findByText(/Server key backup discarded\. Future publications will advance to epoch 2/)).toBeInTheDocument()
    unmount()

    // Fresh device with empty vault restores directly from remote server backup.
    mocks.available = false
    mocks.getRemote.mockResolvedValueOnce({
      status: 'active',
      backup: {
        backupEpoch: 2,
        kdfKind: 'recovery-key',
        iterations: 0,
        capsuleSha256: 'b'.repeat(64),
        sourceDeviceId: '01950000-0000-7000-8000-000000000001',
        publishedAt: '2026-11-24T12:05:00Z',
        capsule: btoa(String.fromCharCode(...remoteBytes)),
        capsuleBytes: remoteBytes.slice(),
      },
    })
    render(<SecuritySettings {...props} />)
    const freshUser = await start()
    expect(screen.getByText(/Opaque server backup stored \(epoch 2, recovery-key\)/)).toBeInTheDocument()
    await freshUser.type(
      screen.getByLabelText('Archive recovery key, including checksum'),
      'saved-recovery-key'
    )
    await freshUser.click(screen.getByRole('button', { name: 'Restore from server backup' }))
    expect(mocks.restore).toHaveBeenCalledWith(
      remoteBytes,
      {
        kind: 'recovery-key',
        recoveryKey: 'saved-recovery-key',
      },
      2
    )
    expect(mocks.advanceEpoch).toHaveBeenCalledWith(3)
    expect(await screen.findByText(/Archive restored locally/)).toBeInTheDocument()
  })
  it('decouples local .kvkb archive epoch from server nextBackupEpoch on fresh device restore and advances on 409 conflict', async () => {
    mocks.available = false
    // Server previously discarded epoch 4, so GET 404 returns X-Kodera-Next-Backup-Epoch: 5.
    mocks.getRemote.mockResolvedValueOnce({ status: 'absent', nextBackupEpoch: 5 })
    const headerJson = JSON.stringify([
      'kodera-zk-key-backup',
      1,
      'org-test',
      'account-test',
      1,
      'recovery-key',
      0,
      btoa(String.fromCharCode(...new Uint8Array(16).fill(1))),
      btoa(String.fromCharCode(...new Uint8Array(12).fill(2))),
    ])
    const headerBytes = new TextEncoder().encode(headerJson)
    const kvkbEpoch1 = new Uint8Array(9 + headerBytes.length + 32)
    kvkbEpoch1.set([0x4b, 0x56, 0x4b, 0x42, 0x31], 0)
    new DataView(kvkbEpoch1.buffer).setUint32(5, headerBytes.length)
    kvkbEpoch1.set(headerBytes, 9)
    kvkbEpoch1.fill(0xaa, 9 + headerBytes.length)

    render(<SecuritySettings {...props} />)
    const user = await start()
    // Fresh device did NOT advance worker to 5 before restore, so epoch-1 .kvkb restores cleanly!
    expect(mocks.advanceEpoch).not.toHaveBeenCalled()

    const file = new File([kvkbEpoch1], 'epoch1.kvkb')
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => kvkbEpoch1.slice().buffer,
    })
    await user.upload(screen.getByLabelText('Choose encrypted .kvkb archive'), file)
    await user.type(
      screen.getByLabelText('Archive recovery key, including checksum'),
      'saved-recovery-key'
    )
    await user.click(screen.getByRole('button', { name: 'Restore archive locally' }))
    expect(mocks.restore).toHaveBeenCalledWith(
      kvkbEpoch1,
      { kind: 'recovery-key', recoveryKey: 'saved-recovery-key' },
      1
    )
    // After restoring epoch 1, session advances to max(1 + 1, 5) = 5 for future server publication!
    expect(mocks.advanceEpoch).toHaveBeenCalledWith(5)
    expect(await screen.findByText(/Archive restored locally/)).toBeInTheDocument()
  })
})

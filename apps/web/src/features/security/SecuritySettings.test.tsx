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
  }),
}))
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
    capsule: new Uint8Array([1, 2, 3]),
    recoveryKey: 'one-time-recovery-key',
  })
  mocks.restore.mockResolvedValue(true)
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
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
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
})

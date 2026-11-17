import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import '../../i18n'
import WorkspaceSettings from './WorkspaceSettings'
import { getLocalProfile } from '../profile/localProfile'

const runtime = {
  org: 'community',
  userId: '@member:community.kodera.io',
  displayName: 'Member',
  members: [{ userId: '@member:community.kodera.io', name: 'Member' }],
  call: null,
  invite: vi.fn().mockResolvedValue(undefined),
  memberRole: () => 'member',
}
vi.mock('./settingsRuntime', () => ({ useWorkspaceSettingsRuntime: () => runtime }))
vi.mock('./queries', () => ({
  useWorkspaceTenantQuery: () => ({ data: { hostingMode: 'community' } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    onClick,
  }: {
    children: ReactNode
    to: string
    params: { org: string }
    onClick?: () => void
  }) => (
    <a href={to.replace('$org', params.org)} onClick={onClick}>
      {children}
    </a>
  ),
}))
vi.mock('./HostingOfferPanel', () => ({ HostingOfferPanel: () => <div>Hosting</div> }))
vi.mock('../extensions/ExtensionsCatalogPanel', () => ({
  ExtensionsCatalogPanel: () => <div>Extensions</div>,
}))
const props = {
  org: 'community',
  organisationId: 'org-community',
  organisationName: 'Community',
  displayName: 'Member',
  role: 'org_member' as const,
  returnFocus: { current: null },
  onClose: vi.fn(),
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

it('persists profile changes and allows clearing the display name before typing', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  const field = screen.getByRole('textbox', { name: 'Nom d’affichage' })
  await user.clear(field)
  expect(field).toHaveValue('')
  await user.type(field, 'Alex')
  await user.type(screen.getByRole('textbox', { name: 'Message de statut' }), 'Reviewing')
  await user.click(screen.getByRole('radio', { name: 'Concentré' }))
  expect(getLocalProfile(runtime.userId)).toEqual({
    displayName: 'Alex',
    status: 'Reviewing',
    presence: 'focused',
  })
  await user.click(screen.getByRole('button', { name: 'Copier l’ID Matrix' }))
  expect(await navigator.clipboard.readText()).toBe(runtime.userId)
  await user.keyboard('{Escape}')
  expect(props.onClose).toHaveBeenCalled()
})

it('keeps appearance and audio available to a member while filtering admin destinations', async () => {
  const user = userEvent.setup()
  render(<WorkspaceSettings {...props} />)
  await user.click(screen.getByRole('tab', { name: 'Apparence & thèmes' }))
  // Every theme the console has, named as the appearance screen names them — the panel offered
  // three of six, so the default (« Ciel ») had no card and no member could come back to it.
  for (const theme of ['Automatique', 'Ciel', 'Ciel nuit', 'Clair', 'Sombre', 'Noir']) {
    expect(screen.getByRole('button', { name: theme })).toBeVisible()
  }
  await user.click(screen.getByRole('button', { name: 'Noir' }))
  expect(localStorage.getItem('console:theme')).toBe('black')
  await user.click(screen.getByRole('button', { name: 'Ciel nuit' }))
  expect(localStorage.getItem('console:theme')).toBe('ciel-nuit')
  await user.click(screen.getByRole('button', { name: 'Ouvrir Theme Studio' }))
  expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)
  await user.keyboard('{Escape}')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await user.click(screen.getByRole('tab', { name: 'Voix & audio' }))
  expect(await screen.findByRole('button', { name: 'Tester le son' })).toBeVisible()
  expect(await screen.findByRole('slider', { name: 'Volume principal' })).toBeVisible()
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  expect(screen.getByRole('heading', { level: 3, name: 'Ambiance sonore' })).toBeVisible()
  expect(screen.getAllByRole('radiogroup', { name: 'Signature sonore' })).toHaveLength(1)
  expect(screen.getAllByRole('radiogroup', { name: 'Mode sonore' })).toHaveLength(1)
  expect(screen.getByRole('switch', { name: 'Mentions et messages' })).toBeVisible()
  expect(
    screen.getByRole('radiogroup', { name: 'Signal de mention et message direct' })
  ).toBeVisible()
  await user.click(screen.getByRole('tab', { name: 'Hébergement & administration' }))
  // « Sécurité & MFA » and « Fédération » are not offered: both routes render only the
  // placeholder today, so following either lands on « Cette page n'est pas encore disponible »,
  // which reads as something broken rather than as something not built.
  expect(screen.queryByRole('link', { name: 'Sécurité & MFA' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Fédération' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Statut' })).toBeVisible()
  expect(screen.queryByRole('link', { name: 'Facturation' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Domaine' })).toBeNull()
})

it('validates Matrix invitations and waits for the room acknowledgement', async () => {
  const user = userEvent.setup()
  let resolve: () => void = () => undefined
  runtime.invite.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  render(<WorkspaceSettings {...props} />)
  await user.click(screen.getByRole('tab', { name: 'Membres, rôles & invitations' }))
  await user.click(screen.getByRole('button', { name: 'Inviter dans cette conversation' }))
  expect(runtime.invite).not.toHaveBeenCalled()
  await user.type(
    screen.getByRole('textbox', { name: 'Identifiant Matrix à inviter' }),
    '@partner:example.org'
  )
  await user.click(screen.getByRole('button', { name: 'Inviter dans cette conversation' }))
  expect(runtime.invite).toHaveBeenCalledWith('@partner:example.org')
  expect(screen.queryByText('Invitation envoyée.')).toBeNull()
  await act(async () => resolve())
  await waitFor(() => expect(screen.getByText('Invitation envoyée.')).toBeVisible())
})

it('sanitizes member display names, isolates MXIDs with bdi, and holds busy until clearAvatar settles', async () => {
  const user = userEvent.setup()
  let finishClear: () => void = () => undefined
  const clearAvatar = vi.fn(
    () =>
      new Promise<void>((done) => {
        finishClear = done
      })
  )
  const createUrlSpy = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:https://console.test/avatar')
  const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const originalMembers = runtime.members
  ;(runtime as { members: unknown; profile?: unknown }).members = [
    { userId: '@member:community.kodera.io', name: 'Member' },
    {
      userId: '@ce239589-a4bd-41db-9cfb-d06e66a77ff3:community.kodera.io',
      name: 'ce239589-a4bd-41db-9cfb-d06e66a77ff3',
    },
    { userId: '@spoof:community.kodera.io', name: 'Alice\u202E\u061C Spoof' },
  ]
  ;(runtime as { profile?: unknown }).profile = {
    matrixDisplayName: 'Member',
    avatarKey: 'mxc://community.kodera.io/pic1',
    fetchAvatar: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
    setDisplayName: vi.fn(async () => undefined),
    setAvatar: vi.fn(async () => undefined),
    clearAvatar,
  }
  try {
    render(<WorkspaceSettings {...props} />)
    // Single unified avatar image in Profile summary card
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:https://console.test/avatar')
    )
    expect(screen.getAllByRole('img')).toHaveLength(1)

    const removeBtn = screen.getByRole('button', { name: 'Retirer la photo' })
    await user.click(removeBtn)
    expect(clearAvatar).toHaveBeenCalledTimes(1)
    expect(removeBtn).toBeDisabled()
    await act(async () => finishClear())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choisir une image' })).toBeEnabled()
    )

    await user.click(screen.getByRole('tab', { name: 'Membres, rôles & invitations' }))
    expect(screen.getByText('Membre · ce23')).toBeVisible()
    expect(screen.getByText('Alice Spoof')).toBeVisible()
    const bdi = screen.getByText('@spoof:community.kodera.io')
    expect(bdi.tagName.toLowerCase()).toBe('bdi')
    expect(bdi).toHaveAttribute('dir', 'ltr')
  } finally {
    ;(runtime as { members: unknown; profile?: unknown }).members = originalMembers
    delete (runtime as { profile?: unknown }).profile
    createUrlSpy.mockRestore()
    revokeUrlSpy.mockRestore()
  }
})

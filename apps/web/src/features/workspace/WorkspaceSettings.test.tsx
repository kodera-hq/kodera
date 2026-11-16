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

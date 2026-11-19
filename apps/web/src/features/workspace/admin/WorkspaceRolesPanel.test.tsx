import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as IamApiModule from '../iamApi'
import '../../../i18n'
import { IamUnsupported } from '../iamApi'
import { mayGrant, mayManage, WorkspaceRolesPanel } from './WorkspaceRolesPanel'
import { ORG, OWNER, renderPanel, role } from './test-support'

const api = vi.hoisted(() => ({
  listWorkspaceRoles: vi.fn(),
  createWorkspaceRole: vi.fn(),
  updateWorkspaceRole: vi.fn(),
  deleteWorkspaceRole: vi.fn(),
}))
vi.mock('../iamApi', async (actual) => ({
  ...(await actual<typeof IamApiModule>()),
  ...api,
}))

const builders = role({
  id: 'r-builders',
  name: 'Builders',
  position: 10,
  member_count: 3,
  is_hoisted: true,
  is_mentionable: true,
  icon: '🔧',
  permissions: ['channel.view', 'message.post'],
})
const guests = role({ id: 'r-guests', name: 'Invités', kind: 'tag', position: 2, member_count: 1 })

beforeEach(() => {
  vi.clearAllMocks()
  api.listWorkspaceRoles.mockResolvedValue({ roles: [guests, builders], assignments: [] })
  api.createWorkspaceRole.mockImplementation(async (_org, draft) => role({ id: 'new', ...draft }))
  api.updateWorkspaceRole.mockImplementation(async (_org, current, patch) => ({
    ...current,
    ...patch,
  }))
  api.deleteWorkspaceRole.mockResolvedValue(undefined)
})

describe('Rôles & Tags', () => {
  it('lists roles by rank with their kind, member count and markers, and searches them', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    const list = await screen.findByRole('list', { name: 'Rôles & Tags' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Builders')
    expect(rows[0]).toHaveTextContent('Affiché séparément')
    expect(rows[0]).toHaveTextContent('@builders')
    expect(within(rows[0]!).getByLabelText('3 membres')).toBeVisible()
    expect(rows[1]).toHaveTextContent('Tag')
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher un rôle' }), 'invi')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('Invités')).toBeVisible()
  })

  it('creates a sub-team with a colour, a badge and granular capabilities', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    await user.click(await screen.findByRole('button', { name: 'Créer un rôle' }))
    const editor = screen.getByRole('form', { name: 'Éditeur de rôle' })
    await user.type(within(editor).getByRole('textbox', { name: 'Nom' }), 'Équipe Réseau')
    await user.type(within(editor).getByRole('textbox', { name: /Badge/u }), '🛰️')
    await user.click(within(editor).getByRole('radio', { name: 'Sous-équipe' }))
    const swatches = within(editor).getAllByRole('button', { name: /^Couleur #/u })
    expect(swatches.length).toBeGreaterThanOrEqual(6)
    await user.click(swatches[2]!)
    await user.click(within(editor).getByRole('switch', { name: /Mentionnable/u }))
    await user.click(within(editor).getByRole('checkbox', { name: 'Gérer les rôles' }))
    await user.click(within(editor).getByRole('checkbox', { name: 'Envoyer des messages' }))
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(api.createWorkspaceRole).toHaveBeenCalledTimes(1))
    const draft = api.createWorkspaceRole.mock.calls[0]![1]
    expect(draft).toMatchObject({
      name: 'Équipe Réseau',
      slug: 'equipe-reseau',
      kind: 'subteam',
      icon: '🛰️',
      is_mentionable: true,
      position: 11,
    })
    expect(draft.color).toMatch(/^#[0-9a-f]{6}$/u)
    expect(draft.permissions).toContain('manage_roles')
    expect(draft.permissions).not.toContain('message.post')
    expect(await screen.findByText('Rôle Équipe Réseau créé.')).toBeVisible()
  })

  it('edits a role’s capabilities under its own tag', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    await user.click(await screen.findByRole('button', { name: 'Modifier Builders' }))
    const editor = screen.getByRole('form', { name: 'Éditeur de rôle' })
    expect(within(editor).getByRole('checkbox', { name: 'Envoyer des messages' })).toBeChecked()
    await user.click(within(editor).getByRole('checkbox', { name: 'Parler' }))
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(api.updateWorkspaceRole).toHaveBeenCalled())
    const [, target, patch] = api.updateWorkspaceRole.mock.calls[0]!
    expect(target).toMatchObject({ id: 'r-builders', etag: '"r-builders"' })
    expect(patch.permissions).toEqual(['channel.view', 'message.post', 'media.speak'])
  })

  it('reorders by moving a role above its neighbour', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    expect(await screen.findByRole('button', { name: 'Monter Builders' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Monter Invités' }))
    await waitFor(() => expect(api.updateWorkspaceRole).toHaveBeenCalledTimes(2))
    expect(api.updateWorkspaceRole.mock.calls[0]![1]).toMatchObject({ id: 'r-guests' })
    expect(api.updateWorkspaceRole.mock.calls[0]![2]).toEqual({ position: 10 })
    expect(api.updateWorkspaceRole.mock.calls[1]![1]).toMatchObject({ id: 'r-builders' })
    expect(api.updateWorkspaceRole.mock.calls[1]![2]).toEqual({ position: 2 })
  })

  it('deletes only after a confirmation that names the role', async () => {
    const user = userEvent.setup()
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    await user.click(await screen.findByRole('button', { name: 'Supprimer Invités' }))
    const dialog = await screen.findByRole('dialog', { name: 'Supprimer le rôle Invités ?' })
    expect(api.deleteWorkspaceRole).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer le rôle' }))
    await waitFor(() => expect(api.deleteWorkspaceRole).toHaveBeenCalledWith(ORG, 'r-guests'))
  })

  it('limits a delegated manager to roles below their ceiling and capabilities they hold', async () => {
    const user = userEvent.setup()
    const delegate = { owner: false, ceiling: 5, held: new Set(['channel.view'] as const) }
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={delegate} />)
    const list = await screen.findByRole('list', { name: 'Rôles & Tags' })
    const [top, bottom] = within(list).getAllByRole('listitem')
    expect(top).toHaveTextContent('Au-dessus de votre rôle')
    expect(within(top!).queryByRole('button', { name: 'Modifier Builders' })).toBeNull()
    await user.click(within(bottom!).getByRole('button', { name: 'Modifier Invités' }))
    const editor = screen.getByRole('form', { name: 'Éditeur de rôle' })
    expect(within(editor).getByRole('checkbox', { name: 'Voir les salons' })).toBeEnabled()
    expect(within(editor).getByRole('checkbox', { name: 'Gérer les rôles' })).toBeDisabled()
    expect(editor).toHaveTextContent('que les droits que vous détenez')
  })

  it('says the feature arrives with a server update on an older server', async () => {
    api.listWorkspaceRoles.mockRejectedValue(new IamUnsupported())
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    expect(await screen.findByRole('note')).toHaveTextContent('prochaine mise à jour du serveur')
  })

  it('applies the hierarchy rules', () => {
    const delegate = { owner: false, ceiling: 5, held: new Set(['message.post'] as const) }
    expect(mayManage(delegate, { position: 4 })).toBe(true)
    expect(mayManage(delegate, { position: 5 })).toBe(false)
    expect(mayGrant(delegate, 'message.post')).toBe(true)
    expect(mayGrant(delegate, 'manage_roles')).toBe(false)
    expect(mayManage(OWNER, { position: 999 })).toBe(true)
  })
})

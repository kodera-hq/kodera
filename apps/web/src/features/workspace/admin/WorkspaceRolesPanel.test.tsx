import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as IamApiModule from '../iamApi'
import '../../../i18n'
import { IamUnsupported, type WorkspaceCapability } from '../iamApi'
import { mayGrant, mayManage, WorkspaceRolesPanel } from './WorkspaceRolesPanel'
import { ROLE_SWATCHES } from './WorkspaceProfilePanel'
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
    const delegate = { owner: false, admin: false, ceiling: 5, held: new Set(['channel.view'] as const) }
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

  it('starts a new role for a delegate with only the default capabilities they hold', async () => {
    const user = userEvent.setup()
    const delegate = {
      owner: false,
      admin: false,
      ceiling: 5,
      held: new Set(['channel.view', 'message.post'] as const),
    }
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={delegate} />)
    await user.click(await screen.findByRole('button', { name: 'Créer un rôle' }))
    const editor = screen.getByRole('form', { name: 'Éditeur de rôle' })
    expect(within(editor).getByRole('checkbox', { name: 'Voir les salons' })).toBeChecked()
    expect(within(editor).getByRole('checkbox', { name: 'Envoyer des messages' })).toBeChecked()
    // Not held by the delegate: neither pre-checked nor togglable.
    expect(within(editor).getByRole('checkbox', { name: 'Lire l’historique' })).toBeDisabled()
    expect(within(editor).getByRole('checkbox', { name: 'Répondre dans les fils' })).toBeDisabled()
    expect(within(editor).getByRole('checkbox', { name: 'Ajouter des réactions' })).toBeDisabled()
    await user.type(within(editor).getByRole('textbox', { name: 'Nom' }), 'Support')
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(api.createWorkspaceRole).toHaveBeenCalledTimes(1))
    expect(api.createWorkspaceRole.mock.calls[0]![1].permissions).toEqual([
      'channel.view',
      'message.post',
    ])
  })

  it('never prepends a colour the contract would refuse to the swatch row', async () => {
    const user = userEvent.setup()
    // A role whose colour Core dropped (outside the contract's pattern) arrives empty.
    api.listWorkspaceRoles.mockResolvedValue({
      roles: [role({ id: 'r-plain', name: 'Plain', color: '' })],
      assignments: [],
    })
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    await user.click(await screen.findByRole('button', { name: 'Modifier Plain' }))
    const editor = screen.getByRole('form', { name: 'Éditeur de rôle' })
    // The row shows exactly the token swatches — no empty extra dot in front.
    expect(within(editor).getAllByRole('button', { name: /^Couleur #/u })).toHaveLength(
      ROLE_SWATCHES.length
    )
  })

  it('separates equal-position roles downward instead of pushing one to the ceiling Core refuses', async () => {
    const user = userEvent.setup()
    api.listWorkspaceRoles.mockResolvedValue({
      roles: [
        role({ id: 'r-a', name: 'Alpha', position: 2 }),
        role({ id: 'r-b', name: 'Beta', position: 2 }),
      ],
      assignments: [],
    })
    // A non-owner whose ceiling is 3: equal positions 2/2 cannot go to 3 (Core answers 403).
    const delegate = { owner: false, admin: false, ceiling: 3, held: new Set<WorkspaceCapability>() }
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={delegate} />)
    await user.click(await screen.findByRole('button', { name: 'Monter Beta' }))
    await waitFor(() => expect(api.updateWorkspaceRole).toHaveBeenCalledTimes(1))
    // `above` keeps its slot; the pair is separated downward instead.
    expect(api.updateWorkspaceRole.mock.calls[0]![1]).toMatchObject({ id: 'r-a' })
    expect(api.updateWorkspaceRole.mock.calls[0]![2]).toEqual({ position: 1 })
  })

  it('disables the move when equal positions sit at the floor and the ceiling is next', async () => {
    api.listWorkspaceRoles.mockResolvedValue({
      roles: [
        role({ id: 'r-a', name: 'Alpha', position: 0 }),
        role({ id: 'r-b', name: 'Beta', position: 0 }),
      ],
      assignments: [],
    })
    const delegate = { owner: false, admin: false, ceiling: 1, held: new Set<WorkspaceCapability>() }
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={delegate} />)
    expect(await screen.findByRole('button', { name: 'Monter Beta' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Descendre Alpha' })).toBeDisabled()
  })

  it('says the feature arrives with a server update on an older server', async () => {
    api.listWorkspaceRoles.mockRejectedValue(new IamUnsupported())
    renderPanel(<WorkspaceRolesPanel organisationId={ORG} authority={OWNER} />)
    expect(await screen.findByRole('note')).toHaveTextContent('prochaine mise à jour du serveur')
  })

  it('applies the hierarchy rules', () => {
    const delegate = {
      owner: false,
      admin: false,
      ceiling: 5,
      held: new Set(['message.post'] as const),
    }
    const below = role({ id: 'r-below', name: 'Below', position: 4, permissions: ['message.post'] })
    expect(mayManage(delegate, below)).toBe(true)
    expect(mayManage(delegate, role({ id: 'r-at', name: 'At', position: 5 }))).toBe(false)
    // Core's default roles are never managed from the console, not even by the owner.
    expect(
      mayManage(delegate, role({ id: 'r-def', name: 'Default', position: 4, is_default: true }))
    ).toBe(false)
    expect(
      mayManage(OWNER, role({ id: 'r-def', name: 'Default', position: 999, is_default: true }))
    ).toBe(false)
    // A delegate only manages roles whose capabilities they hold themselves.
    expect(
      mayManage(delegate, role({ id: 'r-rich', name: 'Rich', position: 4, permissions: ['manage_roles'] }))
    ).toBe(false)
    expect(mayGrant(delegate, 'message.post')).toBe(true)
    expect(mayGrant(delegate, 'manage_roles')).toBe(false)
    expect(mayManage(OWNER, role({ id: 'r-any', name: 'Any', position: 999 }))).toBe(true)
    // An administrator manages below their ceiling and grants anything, like Core allows.
    const admin = { owner: false, admin: true, ceiling: 5, held: new Set<never>() }
    expect(
      mayManage(admin, role({ id: 'r-rich', name: 'Rich', position: 4, permissions: ['manage_roles'] }))
    ).toBe(true)
    expect(mayManage(admin, role({ id: 'r-at', name: 'At', position: 5 }))).toBe(false)
    expect(mayGrant(admin, 'manage_roles')).toBe(true)
  })
})

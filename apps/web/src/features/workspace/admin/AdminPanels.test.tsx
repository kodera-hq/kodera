import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as IamApiModule from '../iamApi'
import type * as ModerationApiModule from '../moderation/moderationApi'
import type * as WorkspaceQueriesModule from '../queries'
import type * as MembersApiModule from './membersApi'
import '../../../i18n'
import { AuditLogPanel, auditActionVerb, auditCategory } from './AuditLogPanel'
import { ChannelOverridesPanel } from './ChannelOverridesPanel'
import { CommunityPanel } from './CommunityPanel'
import { InvitesPanel } from './InvitesPanel'
import { WorkspaceMembersPanel } from './WorkspaceMembersPanel'
import { adminCopy } from './adminMessages'
import { ORG, OWNER, PROFILE, renderPanel, role, WORKSPACE } from './test-support'

const api = vi.hoisted(() => ({
  listWorkspaceRoles: vi.fn(),
  getWorkspaceProfile: vi.fn(),
  updateWorkspaceProfile: vi.fn(),
  getChannelOverrides: vi.fn(),
  setChannelOverrides: vi.fn(),
  setMemberRoles: vi.fn(),
  listInvites: vi.fn(),
  createInvite: vi.fn(),
  listWorkspaceAuditLogs: vi.fn(),
}))
vi.mock('../iamApi', async (actual) => ({
  ...(await actual<typeof IamApiModule>()),
  ...api,
}))
const moderation = vi.hoisted(() => ({ revokeInviteLink: vi.fn(async () => undefined) }))
vi.mock('../moderation/moderationApi', async (actual) => ({
  ...(await actual<typeof ModerationApiModule>()),
  ...moderation,
}))
vi.mock('../queries', async (actual) => ({
  ...(await actual<typeof WorkspaceQueriesModule>()),
  useWorkspaceQuery: () => ({ data: WORKSPACE }),
}))
const people = vi.hoisted(() => ({
  rows: [
    {
      id: 'member-camille',
      person_id: 'person-camille',
      identity_id: 'identity-camille',
      display_name: 'Camille Dubois',
      email: 'camille@acme.fr',
      role: 'org_owner',
      state: 'active',
    },
    {
      id: 'member-marc',
      person_id: 'person-marc',
      identity_id: 'identity-marc',
      display_name: 'Marc Petit',
      email: 'marc@acme.fr',
      role: 'org_member',
      state: 'active',
    },
  ],
}))
vi.mock('./membersApi', async (actual) => ({
  ...(await actual<typeof MembersApiModule>()),
  useDirectory: () => ({
    data: { pages: [{ data: people.rows, has_more: false, next_cursor: null }] },
    hasNextPage: false,
    isError: false,
  }),
}))

const builders = role({ id: 'r-builders', name: 'Builders', position: 10 })
const design = role({ id: 'r-design', name: 'Design', kind: 'subteam', position: 4, icon: '🎨' })

beforeEach(() => {
  vi.clearAllMocks()
  api.listWorkspaceRoles.mockResolvedValue({
    roles: [builders, design],
    assignments: [{ membership_id: 'member-marc', role_ids: ['r-builders'] }],
  })
  api.getWorkspaceProfile.mockResolvedValue({ value: PROFILE, etag: '"p1"' })
  api.updateWorkspaceProfile.mockImplementation(async (_org, patch) => ({
    value: { ...PROFILE, ...patch },
    etag: '"p2"',
  }))
  api.getChannelOverrides.mockResolvedValue([
    { role_id: 'r-builders', allow: [], deny: ['message.post'] },
  ])
  api.setChannelOverrides.mockImplementation(async (_org, _channel, rows) => rows)
  api.setMemberRoles.mockImplementation(async (_org, membership, ids) => ({
    membership_id: membership,
    role_ids: ids,
  }))
  api.listInvites.mockResolvedValue([
    {
      id: '00000000-0000-7000-8000-00000000abcd',
      expiresAt: '2026-12-01T10:00:00Z',
      maxUses: 25,
      usesCount: 4,
      channelId: 'c-arrivees',
      role: 'org_member',
      host: 'Camille Dubois',
      autoRoleIds: ['r-design'],
    },
  ])
  api.createInvite.mockResolvedValue({ code: 'secret-code' })
  api.listWorkspaceAuditLogs.mockImplementation(async (_org, filter) => ({
    data: [
      {
        id: 'e1',
        occurred_at: '2026-11-18T09:00:00Z',
        actor_id: 'identity-camille',
        actor_type: 'tenant',
        action: 'workspace.role.created',
        target_urn: 'urn:kodera:workspace_role:r-builders',
      },
      {
        id: 'e2',
        occurred_at: '2026-11-18T08:00:00Z',
        actor_id: null,
        actor_type: 'system',
        action: 'workspace.invite_link.revoked',
        target_urn: 'urn:kodera:invite:l1',
      },
      {
        id: 'e3',
        occurred_at: '2026-11-18T07:00:00Z',
        actor_id: 'identity-marc',
        actor_type: 'tenant',
        action: 'workspace.member.ban',
        target_urn: 'urn:kodera:membership:member-marc',
      },
      {
        id: 'e4',
        occurred_at: '2026-11-18T06:00:00Z',
        actor_id: 'identity-ghost',
        actor_type: 'tenant',
        action: 'workspace.member.kick',
        target_urn: 'urn:kodera:membership:member-gone',
      },
    ].filter((event) => filter?.actorId === undefined || event.actor_id === filter.actorId),
    hasMore: false,
    nextCursor: null,
  }))
})

describe('Salons & permissions', () => {
  it('shows each capability as allow / inherit / deny and replaces the channel’s overrides', async () => {
    const user = userEvent.setup()
    renderPanel(<ChannelOverridesPanel organisationId={ORG} authority={OWNER} />)
    const post = await screen.findByRole('radiogroup', { name: 'Envoyer des messages' })
    expect(within(post).getByRole('radio', { name: 'Refuser' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    const view = screen.getByRole('radiogroup', { name: 'Voir les salons' })
    expect(within(view).getByRole('radio', { name: 'Hériter' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await user.click(within(view).getByRole('radio', { name: 'Autoriser' }))
    await user.click(within(post).getByRole('radio', { name: 'Hériter' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(api.setChannelOverrides).toHaveBeenCalledTimes(1))
    expect(api.setChannelOverrides).toHaveBeenCalledWith(ORG, 'c-arrivees', [
      { role_id: 'r-builders', allow: ['channel.view'], deny: [] },
    ])
  })

  it('keeps a role above a delegate’s ceiling read-only', async () => {
    renderPanel(
      <ChannelOverridesPanel
        organisationId={ORG}
        authority={{ owner: false, admin: false, ceiling: 5, held: new Set() }}
      />
    )
    const view = await screen.findByRole('radiogroup', { name: 'Voir les salons' })
    expect(within(view).getByRole('radio', { name: 'Autoriser' })).toBeDisabled()
  })

  it('locks every cell when an existing override row names a role the caller cannot manage', async () => {
    const user = userEvent.setup()
    // An administrator with a ceiling of 5 may edit Design (position 4) and grant anything,
    // but the channel's saved overrides still name Builders (position 10): Core would refuse
    // the whole PUT, so every cell stays read-only.
    renderPanel(
      <ChannelOverridesPanel
        organisationId={ORG}
        authority={{ owner: false, admin: true, ceiling: 5, held: new Set() }}
      />
    )
    await user.click(await screen.findByRole('combobox', { name: 'Rôle' }))
    await user.click(await screen.findByRole('option', { name: /^Design/ }))
    const view = await screen.findByRole('radiogroup', { name: 'Voir les salons' })
    expect(within(view).getByRole('radio', { name: 'Autoriser' })).toBeDisabled()
    expect(within(view).getByRole('radio', { name: 'Refuser' })).toBeDisabled()
  })
})

describe('Membres', () => {
  it('assigns and removes workspace roles as pills', async () => {
    const user = userEvent.setup()
    renderPanel(
      <WorkspaceMembersPanel
        organisationId={ORG}
        callerRole="org_owner"
        callerMembershipId="member-camille"
        authority={OWNER}
      />
    )
    const roles = await screen.findByRole('list', { name: 'Rôles de Marc Petit' })
    expect(within(roles).getByText('Builders')).toBeVisible()
    await user.click(within(roles).getByRole('button', { name: 'Attribuer un rôle à Marc Petit' }))
    await user.click(await screen.findByRole('menuitem', { name: /Design · Sous-équipe/u }))
    await waitFor(() =>
      expect(api.setMemberRoles).toHaveBeenCalledWith(ORG, 'member-marc', [
        'r-builders',
        'r-design',
      ])
    )
    await user.click(within(roles).getByRole('button', { name: 'Retirer Builders à Marc Petit' }))
    await waitFor(() => expect(api.setMemberRoles).toHaveBeenLastCalledWith(ORG, 'member-marc', []))
  })

  it('offers no role change on one’s own row', async () => {
    renderPanel(
      <WorkspaceMembersPanel
        organisationId={ORG}
        callerRole="org_owner"
        callerMembershipId="member-camille"
        authority={OWNER}
      />
    )
    expect(
      await screen.findByRole('button', {
        name: 'Changer le rôle de Camille Dubois (rôle actuel : Propriétaire)',
      })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', {
        name: 'Changer le rôle de Marc Petit (rôle actuel : Membre)',
      })
    ).toBeEnabled()
  })

  it('lets an administrator without a workspace-role ceiling assign no roles', async () => {
    // Core 0.50.0: an org_admin with no owner-assigned workspace role has no hierarchy
    // ceiling, so only the owner bypasses the target checks — the admin cannot assign.
    renderPanel(
      <WorkspaceMembersPanel
        organisationId={ORG}
        callerRole="org_admin"
        callerMembershipId="member-camille"
        authority={{ owner: false, admin: true, ceiling: -1, held: new Set() }}
      />
    )
    const roles = await screen.findByRole('list', { name: 'Rôles de Marc Petit' })
    expect(within(roles).getByText('Builders')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Attribuer un rôle à Marc Petit' })
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retirer Builders à Marc Petit' })).toBeNull()
  })

  it('lets an administrator with a ceiling assign the roles below it', async () => {
    renderPanel(
      <WorkspaceMembersPanel
        organisationId={ORG}
        callerRole="org_admin"
        callerMembershipId="member-camille"
        authority={{ owner: false, admin: true, ceiling: 20, held: new Set() }}
      />
    )
    expect(
      await screen.findByRole('button', { name: 'Attribuer un rôle à Marc Petit' })
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Retirer Builders à Marc Petit' })).toBeEnabled()
  })
})

describe('Invitations', () => {
  it('shows host, masked code, channel, uses, expiry and auto-roles, and revokes after confirming', async () => {
    const user = userEvent.setup()
    renderPanel(<InvitesPanel organisationId={ORG} authority={OWNER} />)
    const table = await screen.findByRole('table', { name: 'Invitations' })
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers.slice(0, 6)).toEqual([
      'Créé par',
      'Code',
      'Salon d’arrivée',
      'Utilisations',
      'Expire le',
      'Rôles attribués',
    ])
    const row = within(table).getAllByRole('row')[1]!
    expect(row).toHaveTextContent('Camille Dubois')
    expect(row).toHaveTextContent('•••• abcd')
    expect(row).toHaveTextContent('#arrivées')
    expect(row).toHaveTextContent('4 / 25')
    expect(row).toHaveTextContent('🎨Design')
    await user.click(within(row).getByRole('button', { name: 'Révoquer le lien vers #arrivées' }))
    const dialog = await screen.findByRole('dialog', { name: 'Révoquer ce lien d’invitation ?' })
    expect(moderation.revokeInviteLink).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Révoquer le lien' }))
    await waitFor(() =>
      expect(moderation.revokeInviteLink).toHaveBeenCalledWith(
        ORG,
        '00000000-0000-7000-8000-00000000abcd'
      )
    )
  })

  it('creates a link with a landing channel and auto-roles, shown once', async () => {
    const user = userEvent.setup()
    renderPanel(<InvitesPanel organisationId={ORG} authority={OWNER} />)
    await user.click(await screen.findByRole('button', { name: 'Créer un lien' }))
    const form = screen.getByRole('form', { name: 'Créer un lien' })
    await user.click(within(form).getByRole('checkbox', { name: 'Design' }))
    await user.click(within(form).getByRole('button', { name: 'Créer un lien' }))
    await waitFor(() => expect(api.createInvite).toHaveBeenCalled())
    expect(api.createInvite.mock.calls[0]![1]).toMatchObject({
      maxUses: 25,
      role: 'org_member',
      autoRoleIds: ['r-design'],
    })
    expect(await screen.findByText('Copiez-le maintenant : il ne sera plus affiché.')).toBeVisible()
  })

  it('disables auto-role checkboxes for roles above a delegate’s ceiling and never sends them', async () => {
    const user = userEvent.setup()
    // Builders sits at position 10, above this delegate's ceiling of 5: Core would refuse
    // the invite (403), so the checkbox is disabled and the id never leaves the console.
    renderPanel(
      <InvitesPanel
        organisationId={ORG}
        authority={{ owner: false, admin: false, ceiling: 5, held: new Set() }}
      />
    )
    await user.click(await screen.findByRole('button', { name: 'Créer un lien' }))
    const form = screen.getByRole('form', { name: 'Créer un lien' })
    expect(within(form).getByRole('checkbox', { name: 'Builders' })).toBeDisabled()
    expect(within(form).getByRole('checkbox', { name: 'Design' })).toBeEnabled()
    await user.click(within(form).getByRole('checkbox', { name: 'Design' }))
    await user.click(within(form).getByRole('button', { name: 'Créer un lien' }))
    await waitFor(() => expect(api.createInvite).toHaveBeenCalledTimes(1))
    expect(api.createInvite.mock.calls[0]![1].autoRoleIds).toEqual(['r-design'])
  })

  it('pauses invitations through the workspace profile', async () => {
    const user = userEvent.setup()
    renderPanel(<InvitesPanel organisationId={ORG} authority={OWNER} />)
    const toggle = await screen.findByRole('switch', { name: /Suspendre les invitations/u })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() =>
      expect(api.updateWorkspaceProfile).toHaveBeenCalledWith(ORG, { invites_paused: true }, '"p1"')
    )
    expect(await screen.findByText('Invitations suspendues.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Créer un lien' })).toBeDisabled()
  })
})

describe('Logs d’audit', () => {
  it('names actors from the directory — by person id or identity id — and filters by category and actor', async () => {
    const user = userEvent.setup()
    renderPanel(<AuditLogPanel organisationId={ORG} />)
    const log = await screen.findByRole('list', { name: 'Logs d’audit' })
    expect(within(log).getAllByRole('listitem')).toHaveLength(4)
    expect(log).toHaveTextContent('Camille Dubois a créé un rôle')
    expect(log).toHaveTextContent('Kodera a révoqué une invitation')
    // A ban is moderation, and its verb reads as one; the unknown actor gets a neutral name.
    expect(log).toHaveTextContent('Marc Petit a banni la modération')
    expect(log).toHaveTextContent('Membre ou ancien membre a expulsé la modération')
    expect(log.textContent).not.toMatch(/identity-|person-|urn:|workspace\./u)
    await user.click(screen.getByRole('combobox', { name: 'Catégorie' }))
    await user.click(await screen.findByRole('option', { name: 'la modération' }))
    expect(within(log).getAllByRole('listitem')).toHaveLength(2)
    await user.click(screen.getByRole('combobox', { name: 'Catégorie' }))
    await user.click(await screen.findByRole('option', { name: 'un rôle' }))
    expect(within(log).getAllByRole('listitem')).toHaveLength(1)
    await user.click(screen.getByRole('combobox', { name: 'Auteur' }))
    await user.click(await screen.findByRole('option', { name: 'Camille Dubois' }))
    await waitFor(() =>
      expect(api.listWorkspaceAuditLogs).toHaveBeenLastCalledWith(ORG, {
        actorId: 'identity-camille',
      })
    )
    expect(within(log).getAllByRole('listitem')).toHaveLength(1)
  })

  it('keeps every actor seen before the filter in the actor dropdown', async () => {
    const user = userEvent.setup()
    renderPanel(<AuditLogPanel organisationId={ORG} />)
    const actorFilter = await screen.findByRole('combobox', { name: 'Auteur' })
    await user.click(actorFilter)
    expect(await screen.findByRole('option', { name: 'Marc Petit' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Membre ou ancien membre' })).toBeVisible()
    await user.click(screen.getByRole('option', { name: 'Camille Dubois' }))
    await waitFor(() =>
      expect(api.listWorkspaceAuditLogs).toHaveBeenLastCalledWith(ORG, {
        actorId: 'identity-camille',
      })
    )
    // The filtered query returns only Camille: the dropdown still lists the others.
    await user.click(screen.getByRole('combobox', { name: 'Auteur' }))
    expect(await screen.findByRole('option', { name: 'Marc Petit' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Membre ou ancien membre' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Camille Dubois' })).toBeVisible()
  })

  it('maps actions to categories', () => {
    expect(auditCategory('workspace.role.created')).toBe('role')
    expect(auditCategory('workspace.member_roles.replaced')).toBe('member')
    expect(auditCategory('workspace.member.roles_updated')).toBe('member')
    expect(auditCategory('workspace.channel_overrides.replaced')).toBe('channel')
    expect(auditCategory('workspace.invite_link.created')).toBe('invite')
    expect(auditCategory('workspace.moderation.ban')).toBe('moderation')
    // Member actions that moderate are moderation, not membership.
    expect(auditCategory('workspace.member.ban')).toBe('moderation')
    expect(auditCategory('workspace.member.unban')).toBe('moderation')
    expect(auditCategory('workspace.member.kick')).toBe('moderation')
    expect(auditCategory('workspace.member.mute')).toBe('moderation')
    expect(auditCategory('workspace.profile.updated')).toBe('profile')
    expect(auditCategory('workspace.unknown')).toBeNull()
    // Underscore-suffixed Core actions land in the same categories.
    expect(auditCategory('workspace.channel_created')).toBe('channel')
    expect(auditCategory('workspace.channel_archived')).toBe('channel')
    expect(auditCategory('workspace.category_deleted')).toBe('channel')
    expect(auditCategory('workspace.invite_link_created')).toBe('invite')
  })

  it('reads the verb of dot-separated and underscore-suffixed Core actions', () => {
    expect(auditActionVerb('workspace.channel_created')).toBe('created')
    expect(auditActionVerb('workspace.channel_archived')).toBe('archived')
    expect(auditActionVerb('workspace.category_deleted')).toBe('deleted')
    expect(auditActionVerb('workspace.channel_unarchived')).toBe('unarchived')
    expect(auditActionVerb('workspace.invite_link_created')).toBe('created')
    expect(auditActionVerb('workspace.invite_link_revoked')).toBe('revoked')
    expect(auditActionVerb('workspace.role.created')).toBe('created')
    expect(auditActionVerb('workspace.member.roles_updated')).toBe('roles_updated')
    expect(auditActionVerb('workspace.member.ban')).toBe('ban')
    expect(auditActionVerb('workspace.member.unban')).toBe('unban')
  })

  it('maps every Core 0.50.0 verb in French and in English, never the fallback', () => {
    const verbs = [
      'created',
      'deleted',
      'archived',
      'unarchived',
      'revoked',
      'banned',
      'unbanned',
      'kicked',
      'muted',
      'unmuted',
      'roles_updated',
      'suspended',
      'reactivated',
      'removed',
    ]
    for (const verb of verbs) {
      expect(adminCopy('fr').auditVerb(verb)).not.toBe('a modifié')
      expect(adminCopy('en').auditVerb(verb)).not.toBe('updated')
    }
    // `updated` is the one verb whose wording is the fallback's.
    expect(adminCopy('fr').auditVerb('updated')).toBe('a modifié')
    expect(adminCopy('en').auditVerb('updated')).toBe('updated')
  })

  it('says what Core did for underscore-suffixed actions: created, archived, deleted', async () => {
    api.listWorkspaceAuditLogs.mockResolvedValue({
      data: [
        {
          id: 'u1',
          occurred_at: '2026-11-18T09:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.channel_created',
          target_urn: 'urn:kodera:channel:c1',
        },
        {
          id: 'u2',
          occurred_at: '2026-11-18T08:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.channel_archived',
          target_urn: 'urn:kodera:channel:c1',
        },
        {
          id: 'u3',
          occurred_at: '2026-11-18T07:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.category_deleted',
          target_urn: 'urn:kodera:category:cat',
        },
      ],
      hasMore: false,
      nextCursor: null,
    })
    renderPanel(<AuditLogPanel organisationId={ORG} />)
    const log = await screen.findByRole('list', { name: 'Logs d’audit' })
    expect(log).toHaveTextContent('Camille Dubois a créé un salon')
    expect(log).toHaveTextContent('Camille Dubois a archivé un salon')
    expect(log).toHaveTextContent('Camille Dubois a supprimé un salon')
  })
})

describe('Communauté & #arrivées', () => {
  it('chooses the welcome, rules and alert channels among text channels', async () => {
    const user = userEvent.setup()
    renderPanel(<CommunityPanel organisationId={ORG} canEdit />)
    const welcome = await screen.findByRole('combobox', { name: /Salon d’accueil/u })
    expect(welcome).toHaveTextContent('#arrivées')
    await user.click(screen.getByRole('combobox', { name: /Salon des règles/u }))
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Aucun', '#arrivées', '#général'])
    await user.click(screen.getByRole('option', { name: '#général' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(api.updateWorkspaceProfile).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          arrivals_channel_id: 'c-arrivees',
          rules_channel_id: 'c-general',
        }),
        '"p1"'
      )
    )
  })
})

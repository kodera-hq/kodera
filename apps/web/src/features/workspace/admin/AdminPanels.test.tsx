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

  // Every workspace.* action Core emits (AuditEvent rows with action__startswith='workspace.'),
  // mapped to the verb auditActionVerb must read and the category auditCategory must return.
  const CORE_ACTION_VERBS: Array<[string, string]> = [
    ['workspace.initialised', 'initialised'],
    ['workspace.category_created', 'created'],
    ['workspace.category_updated', 'updated'],
    ['workspace.category_deleted', 'deleted'],
    ['workspace.channel_created', 'created'],
    ['workspace.channel_updated', 'updated'],
    ['workspace.channel_archived', 'archived'],
    ['workspace.channel_unarchived', 'unarchived'],
    ['workspace.channel_access_changed', 'access_changed'],
    ['workspace.channel_set_refused', 'refused'],
    ['workspace.channel.overrides_updated', 'overrides_updated'],
    ['workspace.role.created', 'created'],
    ['workspace.role.updated', 'updated'],
    ['workspace.role.deleted', 'deleted'],
    ['workspace.member.roles_updated', 'roles_updated'],
    ['workspace.member.kick', 'kick'],
    ['workspace.member.ban', 'ban'],
    ['workspace.member.unban', 'unban'],
    ['workspace.member.mute', 'mute'],
    ['workspace.member.unmute', 'unmute'],
    ['workspace.invite_link.created', 'created'],
    ['workspace.invite_link.channel_granted', 'channel_granted'],
    ['workspace.invite_link.redeemed', 'redeemed'],
    ['workspace.invite_link.revoked', 'revoked'],
    ['workspace.report.created', 'created'],
    ['workspace.report.resolved', 'resolved'],
    ['workspace.report.dismissed', 'dismissed'],
    ['workspace.profile.updated', 'updated'],
    ['workspace.quota.configured', 'configured'],
    ['workspace.document.created', 'created'],
    ['workspace.document.updated', 'updated'],
    ['workspace.document.deleted', 'deleted'],
    ['workspace.document.collab_created', 'created'],
    ['workspace.document.collab_updated', 'updated'],
    ['workspace.document.collab_refused', 'refused'],
    ['workspace.collection.created', 'created'],
    ['workspace.collection.updated', 'updated'],
    ['workspace.collection.deleted', 'deleted'],
    ['workspace.collection.row_updated', 'updated'],
    ['workspace.collection.row_deleted', 'deleted'],
    ['workspace.e2ee.device_registered', 'registered'],
    ['workspace.e2ee.device_revoked', 'revoked'],
    ['workspace.e2ee.package_published', 'published'],
    ['workspace.e2ee.package_claimed', 'claimed'],
    ['workspace.e2ee.room_created', 'created'],
    ['workspace.push_subscription.updated', 'updated'],
    ['workspace.push_subscription.revoked', 'revoked'],
    ['workspace.notification.read', 'read'],
    ['workspace.attachment.upload_created', 'created'],
    ['workspace.attachment.completed', 'completed'],
    ['workspace.url.previewed', 'previewed'],
  ]

  const CORE_ACTION_CATEGORIES: Array<[string, string]> = [
    ['workspace.initialised', 'workspace'],
    ['workspace.category_created', 'channel'],
    ['workspace.category_updated', 'channel'],
    ['workspace.category_deleted', 'channel'],
    ['workspace.channel_created', 'channel'],
    ['workspace.channel_updated', 'channel'],
    ['workspace.channel_archived', 'channel'],
    ['workspace.channel_unarchived', 'channel'],
    ['workspace.channel_access_changed', 'channel'],
    ['workspace.channel_set_refused', 'channel'],
    ['workspace.channel.overrides_updated', 'channel'],
    ['workspace.role.created', 'role'],
    ['workspace.role.updated', 'role'],
    ['workspace.role.deleted', 'role'],
    ['workspace.member.roles_updated', 'member'],
    ['workspace.member.kick', 'moderation'],
    ['workspace.member.ban', 'moderation'],
    ['workspace.member.unban', 'moderation'],
    ['workspace.member.mute', 'moderation'],
    ['workspace.member.unmute', 'moderation'],
    ['workspace.invite_link.created', 'invite'],
    ['workspace.invite_link.channel_granted', 'invite'],
    ['workspace.invite_link.redeemed', 'invite'],
    ['workspace.invite_link.revoked', 'invite'],
    ['workspace.report.created', 'moderation'],
    ['workspace.report.resolved', 'moderation'],
    ['workspace.report.dismissed', 'moderation'],
    ['workspace.profile.updated', 'profile'],
    ['workspace.quota.configured', 'quota'],
    ['workspace.document.created', 'document'],
    ['workspace.document.collab_refused', 'document'],
    ['workspace.collection.created', 'document'],
    ['workspace.collection.row_updated', 'document'],
    ['workspace.e2ee.device_registered', 'security'],
    ['workspace.e2ee.device_revoked', 'security'],
    ['workspace.push_subscription.updated', 'notification'],
    ['workspace.push_subscription.revoked', 'notification'],
    ['workspace.notification.read', 'notification'],
    ['workspace.attachment.upload_created', 'content'],
    ['workspace.attachment.completed', 'content'],
    ['workspace.url.previewed', 'content'],
  ]

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
    // Every real Core action classifies cleanly — never null.
    for (const [action, category] of CORE_ACTION_CATEGORIES) {
      expect(auditCategory(action)).toBe(category)
    }
  })

  it('reads the verb of every real Core workspace action', () => {
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
    // Explicitly: refused sets, granted channel access, access changes, overrides, reports,
    // and the present-tense moderation verbs.
    expect(auditActionVerb('workspace.channel_set_refused')).toBe('refused')
    expect(auditActionVerb('workspace.invite_link.channel_granted')).toBe('channel_granted')
    expect(auditActionVerb('workspace.channel_access_changed')).toBe('access_changed')
    expect(auditActionVerb('workspace.channel.overrides_updated')).toBe('overrides_updated')
    expect(auditActionVerb('workspace.report.resolved')).toBe('resolved')
    expect(auditActionVerb('workspace.report.dismissed')).toBe('dismissed')
    expect(auditActionVerb('workspace.member.kick')).toBe('kick')
    expect(auditActionVerb('workspace.member.mute')).toBe('mute')
    expect(auditActionVerb('workspace.member.unmute')).toBe('unmute')
    // Every real Core action string resolves to a known verb.
    for (const [action, verb] of CORE_ACTION_VERBS) {
      expect(auditActionVerb(action)).toBe(verb)
    }
    // An unknown action keeps its own token; the copy renders that token neutrally.
    expect(auditActionVerb('workspace.something_unheard_of')).toBe('something_unheard_of')
  })

  it('maps every Core verb in French and in English, and an unknown verb stays neutral', () => {
    const verbs = [
      'created',
      'updated',
      'deleted',
      'archived',
      'unarchived',
      'assigned',
      'revoked',
      'replaced',
      'removed',
      'suspended',
      'reactivated',
      'ban',
      'unban',
      'kick',
      'mute',
      'unmute',
      'banned',
      'unbanned',
      'kicked',
      'muted',
      'unmuted',
      'roles_updated',
      'overrides_updated',
      'access_changed',
      'channel_granted',
      'refused',
      'redeemed',
      'resolved',
      'dismissed',
      'configured',
      'initialised',
      'completed',
      'read',
      'previewed',
      'registered',
      'published',
      'claimed',
    ]
    for (const verb of verbs) {
      expect(adminCopy('fr').auditVerb(verb)).not.toBe('a enregistré un événement sur')
      expect(adminCopy('en').auditVerb(verb)).not.toBe('recorded an event on')
    }
    expect(adminCopy('fr').auditVerb('updated')).toBe('a modifié')
    expect(adminCopy('en').auditVerb('updated')).toBe('updated')
    // The present-tense Core moderation verbs read like their past-tense twins.
    expect(adminCopy('fr').auditVerb('kick')).toBe('a expulsé')
    expect(adminCopy('fr').auditVerb('kicked')).toBe('a expulsé')
    expect(adminCopy('fr').auditVerb('ban')).toBe('a banni')
    expect(adminCopy('fr').auditVerb('banned')).toBe('a banni')
    expect(adminCopy('fr').auditVerb('unban')).toBe('a rétabli')
    expect(adminCopy('fr').auditVerb('unbanned')).toBe('a rétabli')
    expect(adminCopy('fr').auditVerb('mute')).toBe('a rendu muet')
    expect(adminCopy('fr').auditVerb('muted')).toBe('a rendu muet')
    expect(adminCopy('fr').auditVerb('unmute')).toBe('a rendu la parole à')
    expect(adminCopy('fr').auditVerb('unmuted')).toBe('a rendu la parole à')
    expect(adminCopy('en').auditVerb('kick')).toBe('kicked')
    expect(adminCopy('en').auditVerb('kicked')).toBe('kicked')
    expect(adminCopy('en').auditVerb('ban')).toBe('banned')
    expect(adminCopy('en').auditVerb('banned')).toBe('banned')
    expect(adminCopy('en').auditVerb('unban')).toBe('unbanned')
    expect(adminCopy('en').auditVerb('unbanned')).toBe('unbanned')
    expect(adminCopy('en').auditVerb('mute')).toBe('muted')
    expect(adminCopy('en').auditVerb('muted')).toBe('muted')
    expect(adminCopy('en').auditVerb('unmute')).toBe('unmuted')
    expect(adminCopy('en').auditVerb('unmuted')).toBe('unmuted')
    // The verbs the console must render exactly, in both languages.
    expect(adminCopy('fr').auditVerb('refused')).toBe('n’a pas pu modifier')
    expect(adminCopy('en').auditVerb('refused')).toBe('was refused changes to')
    expect(adminCopy('fr').auditVerb('channel_granted')).toBe('a accordé l’accès salon via')
    expect(adminCopy('en').auditVerb('channel_granted')).toBe('granted channel access via')
    expect(adminCopy('fr').auditVerb('access_changed')).toBe('a modifié l’accès de')
    expect(adminCopy('en').auditVerb('access_changed')).toBe('changed access to')
    expect(adminCopy('fr').auditVerb('overrides_updated')).toBe('a mis à jour les permissions de')
    expect(adminCopy('en').auditVerb('overrides_updated')).toBe('updated the channel permissions of')
    expect(adminCopy('fr').auditVerb('redeemed')).toBe('a utilisé')
    expect(adminCopy('en').auditVerb('redeemed')).toBe('redeemed')
    expect(adminCopy('fr').auditVerb('resolved')).toBe('a résolu')
    expect(adminCopy('en').auditVerb('resolved')).toBe('resolved')
    expect(adminCopy('fr').auditVerb('dismissed')).toBe('a classé sans suite')
    expect(adminCopy('en').auditVerb('dismissed')).toBe('dismissed')
    expect(adminCopy('fr').auditVerb('configured')).toBe('a configuré')
    expect(adminCopy('en').auditVerb('configured')).toBe('configured')
    expect(adminCopy('fr').auditVerb('initialised')).toBe('a initialisé')
    expect(adminCopy('en').auditVerb('initialised')).toBe('initialised')
    expect(adminCopy('fr').auditVerb('completed')).toBe('a terminé')
    expect(adminCopy('en').auditVerb('completed')).toBe('completed')
    expect(adminCopy('fr').auditVerb('read')).toBe('a lu')
    expect(adminCopy('en').auditVerb('read')).toBe('read')
    expect(adminCopy('fr').auditVerb('previewed')).toBe('a prévisualisé')
    expect(adminCopy('en').auditVerb('previewed')).toBe('previewed')
    // An unknown verb is neutral: it can never masquerade as a successful update.
    expect(adminCopy('fr').auditVerb('something_unheard_of')).toBe('a enregistré un événement sur')
    expect(adminCopy('en').auditVerb('something_unheard_of')).toBe('recorded an event on')
    expect(adminCopy('fr').auditVerb('something_unheard_of')).not.toBe('a modifié')
    expect(adminCopy('en').auditVerb('something_unheard_of')).not.toBe('updated')
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

  it('renders refused, granted, access-changed and report actions with their exact verbs', async () => {
    api.listWorkspaceAuditLogs.mockResolvedValue({
      data: [
        {
          id: 'r1',
          occurred_at: '2026-11-18T09:00:00Z',
          actor_id: 'identity-marc',
          actor_type: 'tenant',
          action: 'workspace.channel_set_refused',
          target_urn: 'urn:kodera:channel:c1',
        },
        {
          id: 'r2',
          occurred_at: '2026-11-18T08:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.invite_link.channel_granted',
          target_urn: 'urn:kodera:invite:l1',
        },
        {
          id: 'r3',
          occurred_at: '2026-11-18T07:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.channel_access_changed',
          target_urn: 'urn:kodera:channel:c1',
        },
        {
          id: 'r4',
          occurred_at: '2026-11-18T06:00:00Z',
          actor_id: 'identity-camille',
          actor_type: 'tenant',
          action: 'workspace.report.resolved',
          target_urn: 'urn:kodera:report:rep1',
        },
      ],
      hasMore: false,
      nextCursor: null,
    })
    renderPanel(<AuditLogPanel organisationId={ORG} />)
    const log = await screen.findByRole('list', { name: 'Logs d’audit' })
    // A refused set never reads as a successful change.
    expect(log).toHaveTextContent('Marc Petit n’a pas pu modifier un salon')
    expect(log).toHaveTextContent('Camille Dubois a accordé l’accès salon via une invitation')
    expect(log).toHaveTextContent('Camille Dubois a modifié l’accès de un salon')
    expect(log).toHaveTextContent('Camille Dubois a résolu la modération')
    expect(log.textContent).not.toMatch(/workspace\./u)
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

// Workspace governance (Core v1): the server profile, roles/sub-teams/tags, member role
// assignments, per-channel role overrides, bans and the workspace audit log.
//
// These operations arrive with the granular IAM release of Core (contract 0.50.0). They go through
// the generated client, and every response is still checked before it is trusted. An organisation
// still served by an older Core answers these paths with 404/405/501: that is reported as
// `IamUnsupported`, and each panel says the feature arrives with the next server update instead
// of showing an error.
//
// Core remains the authority: every write is re-checked there (role ceilings, delegated
// capabilities, last-owner protection). What the console hides is a courtesy, never a guard.

import { ApiProblem, coreApi } from '../../api/client'
import type { components } from '../../api/schema'

export const WORKSPACE_CAPABILITIES = [
  'channel.view',
  'channel.history',
  'message.post',
  'message.reply',
  'message.react',
  'message.edit_own',
  'message.delete_own',
  'message.delete_any',
  'message.pin',
  'message.search',
  'file.read',
  'file.upload',
  'file.delete_own',
  'file.delete_any',
  'media.connect',
  'media.speak',
  'media.video',
  'media.share',
  'media.moderate',
  'manage_roles',
  'view_audit_log',
] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

export const ROLE_KINDS = ['role', 'subteam', 'tag'] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

export interface WorkspaceRole {
  id: string
  name: string
  slug: string
  kind: RoleKind
  color: string
  icon: string
  position: number
  is_hoisted: boolean
  is_mentionable: boolean
  /** Core's built-in roles (everyone, admins…) are managed by Core itself, never edited here. */
  is_default: boolean
  permissions: WorkspaceCapability[]
  member_count: number
  etag: string
}

export interface RoleAssignment {
  membership_id: string
  role_ids: string[]
}

export interface WorkspaceRoles {
  roles: WorkspaceRole[]
  assignments: RoleAssignment[]
}

export type RoleDraft = Pick<
  WorkspaceRole,
  'name' | 'kind' | 'color' | 'icon' | 'position' | 'is_hoisted' | 'is_mentionable' | 'permissions'
>

export interface ProfileTrait {
  icon: string
  label: string
}

export interface WorkspaceProfile {
  description: string
  banner_preset: string
  icon_mxc: string
  traits: ProfileTrait[]
  arrivals_channel_id: string | null
  rules_channel_id: string | null
  moderator_updates_channel_id: string | null
  security_alerts_channel_id: string | null
  invites_paused: boolean
}

export interface ChannelOverride {
  role_id: string
  allow: WorkspaceCapability[]
  deny: WorkspaceCapability[]
}

export interface WorkspaceBan {
  id: string
  membership_id: string
  display_name: string | null
  email: string
  updated_at: string
}

export interface AuditEvent {
  id: string
  occurred_at: string
  actor_id: string | null
  actor_type: 'staff' | 'tenant' | 'agent' | 'system'
  action: string
  target_urn: string
}

export interface Page<T> {
  data: T[]
  hasMore: boolean
  nextCursor: string | null
}

export interface Tagged<T> {
  value: T
  etag: string
}

/** The organisation's Core does not serve this governance operation yet. */
export class IamUnsupported extends Error {
  constructor() {
    super('workspace governance unavailable on this server')
    this.name = 'IamUnsupported'
  }
}

export function isIamUnsupported(error: unknown): boolean {
  return error instanceof IamUnsupported
}

/** A refusal the caller can act on: a stale tag (someone else saved first). */
export function isStale(error: unknown): boolean {
  return error instanceof ApiProblem && (error.status === 412 || error.status === 428)
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiProblem && error.status === 403
}

// --- transport ----------------------------------------------------------------------------------

type Schemas = components['schemas']

/**
 * Awaits one call of the shared Core client (bearer token, request id, problem mapping) and
 * reads its tag. An older Core has no such route: the path is unknown (404 with no registered
 * problem), the verb is not routed (405) or the feature is not implemented (501).
 */
async function governed(
  request: Promise<{ data?: unknown; response: Response }>
): Promise<{ data: unknown; etag: string | null }> {
  try {
    const { data, response } = await request
    return { data, etag: response.headers.get('ETag') }
  } catch (error) {
    if (
      error instanceof ApiProblem &&
      (error.status === 405 ||
        error.status === 501 ||
        (error.status === 404 && error.type === null))
    ) {
      throw new IamUnsupported()
    }
    throw error
  }
}

const org = (organisationId: string) => ({ organisation_id: organisationId })

// --- parsing ------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback
const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const capabilities = (value: unknown): WorkspaceCapability[] =>
  Array.isArray(value)
    ? value.filter((item): item is WorkspaceCapability =>
        (WORKSPACE_CAPABILITIES as readonly string[]).includes(item as string)
      )
    : []
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function malformed(what: string): never {
  throw new Error(`${what} answered with an unexpected shape.`)
}

export function parseRole(value: unknown): WorkspaceRole {
  if (!isObject(value) || typeof value['id'] !== 'string') malformed('workspace role')
  const kind = (ROLE_KINDS as readonly string[]).includes(value['kind'] as string)
    ? (value['kind'] as RoleKind)
    : 'role'
  return {
    id: value['id'],
    name: str(value['name']),
    slug: str(value['slug']),
    kind,
    // A colour outside the contract's pattern is dropped; the dot then draws its token default.
    color: /^#[0-9a-fA-F]{6}$/u.test(str(value['color'])) ? str(value['color']) : '',
    icon: str(value['icon']),
    position: typeof value['position'] === 'number' ? value['position'] : 0,
    is_hoisted: value['is_hoisted'] === true,
    is_mentionable: value['is_mentionable'] === true,
    is_default: value['is_default'] === true,
    permissions: capabilities(value['permissions']),
    member_count: typeof value['member_count'] === 'number' ? value['member_count'] : 0,
    etag: str(value['etag']),
  }
}

export function parseProfile(value: unknown): WorkspaceProfile {
  if (!isObject(value)) malformed('workspace profile')
  return {
    description: str(value['description']),
    banner_preset: str(value['banner_preset']),
    icon_mxc: str(value['icon_mxc']),
    traits: Array.isArray(value['traits'])
      ? value['traits'].filter(isObject).map((trait) => ({
          icon: str(trait['icon']),
          label: str(trait['label']),
        }))
      : [],
    arrivals_channel_id: nullableStr(value['arrivals_channel_id']),
    rules_channel_id: nullableStr(value['rules_channel_id']),
    moderator_updates_channel_id: nullableStr(value['moderator_updates_channel_id']),
    security_alerts_channel_id: nullableStr(value['security_alerts_channel_id']),
    invites_paused: value['invites_paused'] === true,
  }
}

function page<T>(value: unknown, item: (row: Record<string, unknown>) => T): Page<T> {
  if (!isObject(value) || !Array.isArray(value['data'])) malformed('workspace page')
  return {
    data: value['data'].filter(isObject).map(item),
    hasMore: value['has_more'] === true,
    nextCursor: nullableStr(value['next_cursor']),
  }
}

// --- profile ------------------------------------------------------------------------------------

export async function getWorkspaceProfile(
  organisationId: string
): Promise<Tagged<WorkspaceProfile>> {
  const { data, etag } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/profile', {
      params: { path: org(organisationId) },
    })
  )
  return { value: parseProfile(data), etag: etag ?? '' }
}

export async function updateWorkspaceProfile(
  organisationId: string,
  patch: Partial<WorkspaceProfile>,
  etag: string
): Promise<Tagged<WorkspaceProfile>> {
  const result = await governed(
    coreApi().PATCH('/organisations/{organisation_id}/workspace/profile', {
      params: { path: org(organisationId), header: { 'If-Match': etag } },
      body: patch,
    })
  )
  return { value: parseProfile(result.data), etag: result.etag ?? etag }
}

// --- roles --------------------------------------------------------------------------------------

/** Highest position first: the order Core ranks authority in, and the order the list shows. */
export function byRank(a: WorkspaceRole, b: WorkspaceRole): number {
  return b.position - a.position || a.name.localeCompare(b.name)
}

export async function listWorkspaceRoles(organisationId: string): Promise<WorkspaceRoles> {
  const { data } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/roles', {
      params: { path: org(organisationId) },
    })
  )
  if (!isObject(data) || !Array.isArray(data['data'])) malformed('workspace roles')
  return {
    roles: data['data'].map(parseRole).sort(byRank),
    assignments: Array.isArray(data['assignments'])
      ? data['assignments'].filter(isObject).map((row) => ({
          membership_id: str(row['membership_id']),
          role_ids: ids(row['role_ids']),
        }))
      : [],
  }
}

/** A slug Core accepts (`^[a-z][a-z0-9_-]{0,63}$`), derived from the role's display name. */
export function roleSlug(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^[^a-z]+/u, '')
      .replace(/-+$/u, '')
      .slice(0, 56) || 'role'
  let slug = base
  for (let n = 2; taken.includes(slug); n += 1) slug = `${base}-${n}`
  return slug
}

/** No colour is sent rather than one the contract refuses: Core then keeps its own default. */
function withoutEmptyColour<T extends { color?: string }>(body: T): T {
  if (body.color !== '') return body
  const rest = { ...body }
  delete rest.color
  return rest
}

export async function createWorkspaceRole(
  organisationId: string,
  draft: RoleDraft & { slug: string }
): Promise<WorkspaceRole> {
  const { data } = await governed(
    coreApi().POST('/organisations/{organisation_id}/workspace/roles', {
      params: { path: org(organisationId), header: { 'Idempotency-Key': crypto.randomUUID() } },
      // Every field but name and slug has a contract default, so an omitted colour is valid.
      body: withoutEmptyColour(draft) as Schemas['WorkspaceRoleCreate'],
    })
  )
  return parseRole(data)
}

export async function updateWorkspaceRole(
  organisationId: string,
  role: Pick<WorkspaceRole, 'id' | 'etag'>,
  patch: Partial<RoleDraft>
): Promise<WorkspaceRole> {
  const { data } = await governed(
    coreApi().PATCH('/organisations/{organisation_id}/workspace/roles/{role_id}', {
      params: {
        path: { ...org(organisationId), role_id: role.id },
        header: { 'If-Match': role.etag },
      },
      // The patch schema requires no field (`required: []`); its defaults read as required.
      body: withoutEmptyColour(patch) as Schemas['WorkspaceRolePatch'],
    })
  )
  return parseRole(data)
}

export async function deleteWorkspaceRole(organisationId: string, roleId: string): Promise<void> {
  await governed(
    coreApi().DELETE('/organisations/{organisation_id}/workspace/roles/{role_id}', {
      params: { path: { ...org(organisationId), role_id: roleId } },
    })
  )
}

export async function setMemberRoles(
  organisationId: string,
  membershipId: string,
  roleIds: readonly string[]
): Promise<RoleAssignment> {
  const { data } = await governed(
    coreApi().PUT('/organisations/{organisation_id}/workspace/members/{membership_id}/roles', {
      params: { path: { ...org(organisationId), membership_id: membershipId } },
      body: { role_ids: [...new Set(roleIds)] },
    })
  )
  if (!isObject(data)) malformed('member roles')
  return {
    membership_id: str(data['membership_id'], membershipId),
    role_ids: ids(data['role_ids']),
  }
}

/** The capabilities the caller holds through assigned roles (a delegated manager's ceiling). */
export function heldCapabilities(
  roles: WorkspaceRoles,
  membershipId: string | undefined
): { capabilities: Set<WorkspaceCapability>; ceiling: number } {
  const assigned = new Set(
    roles.assignments.find((row) => row.membership_id === membershipId)?.role_ids ?? []
  )
  const capabilities = new Set<WorkspaceCapability>()
  let ceiling = -1
  for (const role of roles.roles) {
    if (!assigned.has(role.id)) continue
    for (const permission of role.permissions) capabilities.add(permission)
    ceiling = Math.max(ceiling, role.position)
  }
  return { capabilities, ceiling }
}

// --- channel overrides --------------------------------------------------------------------------

export type OverrideState = 'allow' | 'inherit' | 'deny'

export function overrideState(
  overrides: readonly ChannelOverride[],
  roleId: string,
  capability: WorkspaceCapability
): OverrideState {
  const row = overrides.find((entry) => entry.role_id === roleId)
  if (row?.allow.includes(capability)) return 'allow'
  if (row?.deny.includes(capability)) return 'deny'
  return 'inherit'
}

/** The overrides with one cell changed; allow and deny stay disjoint, empty rows are dropped. */
export function withOverride(
  overrides: readonly ChannelOverride[],
  roleId: string,
  capability: WorkspaceCapability,
  state: OverrideState
): ChannelOverride[] {
  const current = overrides.find((entry) => entry.role_id === roleId) ?? {
    role_id: roleId,
    allow: [],
    deny: [],
  }
  const next: ChannelOverride = {
    role_id: roleId,
    allow: current.allow.filter((item) => item !== capability),
    deny: current.deny.filter((item) => item !== capability),
  }
  if (state === 'allow') next.allow.push(capability)
  if (state === 'deny') next.deny.push(capability)
  const rest = overrides.filter((entry) => entry.role_id !== roleId)
  return next.allow.length + next.deny.length === 0 ? rest : [...rest, next]
}

function parseOverrides(data: unknown): ChannelOverride[] {
  if (!isObject(data) || !Array.isArray(data['data'])) malformed('channel overrides')
  return data['data'].filter(isObject).map((row) => ({
    role_id: str(row['role_id']),
    allow: capabilities(row['allow']),
    deny: capabilities(row['deny']),
  }))
}

export async function getChannelOverrides(
  organisationId: string,
  channelId: string
): Promise<ChannelOverride[]> {
  const { data } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/channels/{channel_id}/overrides', {
      params: { path: { ...org(organisationId), channel_id: channelId } },
    })
  )
  return parseOverrides(data)
}

export async function setChannelOverrides(
  organisationId: string,
  channelId: string,
  overrides: readonly ChannelOverride[]
): Promise<ChannelOverride[]> {
  const { data } = await governed(
    coreApi().PUT('/organisations/{organisation_id}/workspace/channels/{channel_id}/overrides', {
      params: { path: { ...org(organisationId), channel_id: channelId } },
      body: { overrides: overrides.map((row) => ({ ...row })) },
    })
  )
  return parseOverrides(data)
}

// --- bans and audit -----------------------------------------------------------------------------

export async function listWorkspaceBans(
  organisationId: string,
  query: { q?: string; cursor?: string } = {}
): Promise<Page<WorkspaceBan>> {
  const q = query.q?.trim() ?? ''
  const { data } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/bans', {
      params: {
        path: org(organisationId),
        query: {
          limit: 50,
          ...(q === '' ? {} : { q: q.slice(0, 100) }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
      },
    })
  )
  return page(data, (row) => ({
    id: str(row['id']),
    membership_id: str(row['membership_id']),
    display_name: nullableStr(row['display_name']),
    email: str(row['email']),
    updated_at: str(row['updated_at']),
  }))
}

const ACTION = /^[a-z][a-z0-9_.]{0,99}$/u

export async function listWorkspaceAuditLogs(
  organisationId: string,
  filter: { action?: string; actorId?: string; cursor?: string } = {}
): Promise<Page<AuditEvent>> {
  const { data } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/audit-logs', {
      params: {
        path: org(organisationId),
        query: {
          limit: 50,
          ...(filter.action !== undefined && ACTION.test(filter.action)
            ? { action: filter.action }
            : {}),
          ...(filter.actorId === undefined ? {} : { actor_id: filter.actorId }),
          ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
        },
      },
    })
  )
  return page(data, (row) => ({
    id: str(row['id']),
    occurred_at: str(row['occurred_at']),
    actor_id: nullableStr(row['actor_id']),
    actor_type: (['staff', 'tenant', 'agent', 'system'] as const).includes(
      row['actor_type'] as AuditEvent['actor_type']
    )
      ? (row['actor_type'] as AuditEvent['actor_type'])
      : 'system',
    action: str(row['action']),
    target_urn: str(row['target_urn']),
  }))
}

// --- invite links -------------------------------------------------------------------------------

export interface InviteLinkRow {
  id: string
  expiresAt: string
  maxUses: number
  usesCount: number
  channelId: string | null
  role: 'org_member' | 'moderator'
  host: string | null
  autoRoleIds: string[]
}

/** The active links with what the governance release adds: who made each, and its auto-roles. */
export async function listInvites(organisationId: string): Promise<InviteLinkRow[]> {
  const { data } = await governed(
    coreApi().GET('/organisations/{organisation_id}/workspace/invite-links', {
      params: { path: org(organisationId), query: { status: 'active', limit: 50 } },
    })
  )
  if (!isObject(data) || !Array.isArray(data['data'])) malformed('invite links')
  return data['data'].filter(isObject).map((row) => {
    const createdBy = isObject(row['createdBy']) ? row['createdBy'] : null
    return {
      id: str(row['id']),
      expiresAt: str(row['expiresAt']),
      maxUses: typeof row['maxUses'] === 'number' ? row['maxUses'] : 0,
      usesCount: typeof row['usesCount'] === 'number' ? row['usesCount'] : 0,
      channelId: nullableStr(row['channelId']),
      role: row['role'] === 'moderator' ? 'moderator' : 'org_member',
      host: createdBy === null ? null : nullableStr(createdBy['displayName']),
      autoRoleIds: ids(row['auto_role_ids']),
    }
  })
}

export async function createInvite(
  organisationId: string,
  request: {
    expiresAt: string
    maxUses: number
    role: 'org_member' | 'moderator'
    channelId?: string | undefined
    autoRoleIds?: readonly string[] | undefined
  }
): Promise<{ code: string }> {
  const { data } = await governed(
    coreApi().POST('/organisations/{organisation_id}/workspace/invite-links', {
      params: { path: org(organisationId), header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: {
        expiresAt: request.expiresAt,
        maxUses: Math.min(10_000, Math.max(1, Math.round(request.maxUses))),
        role: request.role,
        ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
        ...(request.autoRoleIds === undefined || request.autoRoleIds.length === 0
          ? {}
          : { auto_role_ids: [...request.autoRoleIds] }),
      },
    })
  )
  if (!isObject(data) || typeof data['code'] !== 'string') malformed('invite link')
  return { code: data['code'] }
}

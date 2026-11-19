import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  getWorkspaceProfile,
  heldCapabilities,
  isIamUnsupported,
  listWorkspaceRoles,
  type WorkspaceCapability,
  type WorkspaceRoles,
} from '../iamApi'
import { useWorkspaceQuery } from '../queries'

export const iamKeys = {
  all: (organisationId: string) => ['workspace-iam', organisationId] as const,
  roles: (organisationId: string) => ['workspace-iam', organisationId, 'roles'] as const,
  profile: (organisationId: string) => ['workspace-iam', organisationId, 'profile'] as const,
  overrides: (organisationId: string, channelId: string) =>
    ['workspace-iam', organisationId, 'overrides', channelId] as const,
  bans: (organisationId: string, q: string) =>
    ['workspace-iam', organisationId, 'bans', q] as const,
  audit: (organisationId: string, action: string, actor: string) =>
    ['workspace-iam', organisationId, 'audit', action, actor] as const,
  invites: (organisationId: string) => ['workspace-iam', organisationId, 'invites'] as const,
}

/** An older server is a steady state, not a transient failure: never retried. */
export const retryUnlessUnsupported = (count: number, error: unknown) =>
  !isIamUnsupported(error) && count < 2

export function useWorkspaceRoles(organisationId: string, enabled = true) {
  return useQuery({
    queryKey: iamKeys.roles(organisationId),
    queryFn: () => listWorkspaceRoles(organisationId),
    retry: retryUnlessUnsupported,
    enabled,
  })
}

export function useWorkspaceProfile(organisationId: string) {
  return useQuery({
    queryKey: iamKeys.profile(organisationId),
    queryFn: () => getWorkspaceProfile(organisationId),
    retry: retryUnlessUnsupported,
  })
}

export function useInvalidateIam(organisationId: string) {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: iamKeys.all(organisationId) })
}

export interface ChannelChoice {
  id: string
  name: string
  kind: 'text' | 'audio'
}

/** The workspace's channels as Core knows them (Core ids, not Matrix room ids). */
export function useWorkspaceChannels(organisationId: string): ChannelChoice[] {
  const workspace = useWorkspaceQuery(organisationId).data?.workspace
  return useMemo(() => {
    if (workspace === undefined) return []
    return [
      ...workspace.categories.flatMap((category) => category.channels),
      ...workspace.uncategorised_channels,
    ]
      .filter((channel) => channel.lifecycle === 'active')
      .map((channel) => ({ id: channel.id, name: channel.name, kind: channel.kind }))
  }, [workspace])
}

export interface Delegation {
  manageRoles: boolean
  viewAudit: boolean
  ceiling: number
  held: ReadonlySet<WorkspaceCapability>
}

const NO_DELEGATION: Delegation = {
  manageRoles: false,
  viewAudit: false,
  ceiling: -1,
  held: new Set(),
}

/** What the caller holds through assigned workspace roles; nothing on an older server. */
export function useDelegation(
  organisationId: string,
  membershipId: string | undefined,
  enabled = true
): Delegation {
  const roles = useWorkspaceRoles(organisationId, enabled)
  return useMemo(() => {
    const data: WorkspaceRoles | undefined = roles.data
    if (data === undefined) return NO_DELEGATION
    const held = heldCapabilities(data, membershipId)
    return {
      manageRoles: held.capabilities.has('manage_roles'),
      viewAudit: held.capabilities.has('view_audit_log'),
      ceiling: held.ceiling,
      held: held.capabilities,
    }
  }, [roles.data, membershipId])
}

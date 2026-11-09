// The workspace's calls (docs/specs/11-workspace.md §6), through TanStack Query and the
// generated Core client (ADR-0005).

import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import { fetchFirstTenant } from '../status/queries'
import {
  requireTenant,
  requireWorkspace,
  retryWorkspaceRead,
  tenantPhase,
  tenantRefetchInterval,
  workspaceRefetchInterval,
  workspaceView,
} from './workspace'
import type { Workspace, WorkspaceTenant } from './workspace'

export interface WorkspaceRead {
  workspace: Workspace
  /** `X-Request-Id` of the read, quoted to support when setup has stopped. */
  requestId: string | undefined
}

export function workspaceQueryKey(organisationId: string) {
  return ['workspace', organisationId] as const
}

async function fetchWorkspace(organisationId: string): Promise<WorkspaceRead> {
  const { data, response } = await coreApi().GET('/organisations/{organisation_id}/workspace', {
    params: { path: { organisation_id: organisationId } },
  })
  return {
    workspace: requireWorkspace(data),
    requestId: response.headers.get('X-Request-Id') ?? undefined,
  }
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

/** Read on entering, then again while setup is under way (§4.3). */
export function useWorkspaceQuery(organisationId: string) {
  return useQuery({
    queryKey: workspaceQueryKey(organisationId),
    queryFn: () => fetchWorkspace(organisationId),
    refetchInterval: (query) => {
      const data = query.state.data
      return workspaceRefetchInterval(
        data === undefined ? undefined : workspaceView(data.workspace),
        tabHidden()
      )
    },
    retry: retryWorkspaceRead,
    refetchOnWindowFocus: true,
  })
}

async function fetchWorkspaceTenant(organisationId: string): Promise<WorkspaceTenant | null> {
  const tenant = await fetchFirstTenant(organisationId)
  return tenant === null ? null : requireTenant(tenant)
}

/**
 * The organisation's tenant (quick-workspace SPEC W2): its status says whether its homeserver
 * exists yet, and its slug is that homeserver's server name — which may differ from the
 * organisation's slug. Read again while it is being prepared, so the workspace opens without a
 * reload once an operator sets it active.
 */
export function workspaceTenantQueryKey(organisationId: string) {
  // Not under `['workspace', organisationId]`: rereading the workspace after its creation must not
  // wait on, or fail with, the tenant's read.
  return ['workspace-tenant', organisationId] as const
}

/** The tenant's slug as the workspace last read it, while that tenant is open; `undefined` before
 * it is read, when the organisation has none, and while its homeserver is prepared, stopped or
 * closed: what the live workspace's session and drafts are checked against. */
export function cachedTenantSlug(client: QueryClient, organisationId: string): string | undefined {
  const tenant = client.getQueryData<WorkspaceTenant | null>(
    workspaceTenantQueryKey(organisationId)
  )
  if (tenant === undefined || tenant === null) return undefined
  return tenantPhase(tenant.status) === 'open' ? tenant.slug : undefined
}

export function useWorkspaceTenantQuery(organisationId: string) {
  return useQuery({
    queryKey: workspaceTenantQueryKey(organisationId),
    queryFn: () => fetchWorkspaceTenant(organisationId),
    refetchInterval: (query) => tenantRefetchInterval(query.state.data, tabHidden()),
    // Nothing reads while the tab is hidden; coming back to it reads again.
    refetchOnWindowFocus: true,
    // Kept while the member is in another module: the live workspace's drafts are checked against
    // this slug, and a collected entry would retire them (11-workspace.md, draft continuity).
    gcTime: Infinity,
  })
}

/** Creates the starter workspace. The answer is never drawn: the caller reads `getWorkspace`. */
export async function initialiseWorkspace(organisationId: string, key: string): Promise<void> {
  await mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/actions/initialise' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': key },
      },
    }
  )
}

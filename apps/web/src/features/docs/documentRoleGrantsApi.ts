import { ApiProblem, coreApi } from '@/api/client'
import type { components } from '@/api/schema'

export type DocumentRoleGrant = components['schemas']['DocumentRoleGrant']
export type DocumentGrantRole = DocumentRoleGrant['role']
export type DocumentSubteam = Pick<
  components['schemas']['WorkspaceRole'],
  'id' | 'name' | 'slug'
> & {
  readonly mention: `@${string}`
}

/** A complete direct-grant snapshot. Ancestor permissions are resolved by Core. */
export interface DocumentRoleGrantsState {
  readonly grants: readonly DocumentRoleGrant[]
  readonly revision: number
  readonly etag: string
}

/** Secure UUIDv4 also works on HTTP origins without randomUUID. */
function mutationKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return Array.from(
    bytes,
    (byte, index) =>
      `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`
  ).join('')
}

function exactTag(etag: string): string {
  if (!/^"[^"\r\n]+"$/u.test(etag)) {
    throw new RangeError('An exact grant-list ETag is required to change document permissions.')
  }
  return etag
}

function snapshot(
  data: components['schemas']['DocumentRoleGrantList'] | undefined,
  response: Response
): DocumentRoleGrantsState {
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    grants: data.data,
    revision: data.revision,
    etag: exactTag(response.headers.get('ETag') ?? ''),
  }
}

/** Active members may read workspace roles; only subteams can receive document grants. */
export async function listDocumentSubteams(
  organisationId: string,
  signal?: AbortSignal
): Promise<readonly DocumentSubteam[]> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/roles',
    {
      params: { path: { organisation_id: organisationId } },
      ...(signal ? { signal } : {}),
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return data.data
    .filter((role) => role.kind === 'subteam')
    .map(({ id, name, slug }) => ({ id, name, slug, mention: `@${slug}` as const }))
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id))
}

export async function listDocumentRoleGrants(
  organisationId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<DocumentRoleGrantsState> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants',
    {
      params: { path: { organisation_id: organisationId, document_id: documentId } },
      ...(signal ? { signal } : {}),
    }
  )
  return snapshot(data, response)
}

/** Returns the server's whole snapshot, including its new ETag; callers replace their state. */
export async function putDocumentRoleGrant(
  organisationId: string,
  documentId: string,
  workspaceRoleId: string,
  role: DocumentGrantRole,
  etag: string
): Promise<DocumentRoleGrantsState> {
  const ifMatch = exactTag(etag)
  const { data, response } = await coreApi().PUT(
    '/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants/{role_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
          role_id: workspaceRoleId,
        },
        header: { 'If-Match': ifMatch },
      },
      headers: { 'Idempotency-Key': mutationKey() },
      body: { role },
    }
  )
  return snapshot(data, response)
}

export async function revokeDocumentRoleGrant(
  organisationId: string,
  documentId: string,
  workspaceRoleId: string,
  etag: string
): Promise<DocumentRoleGrantsState> {
  const ifMatch = exactTag(etag)
  const { data, response } = await coreApi().DELETE(
    '/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants/{role_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
          role_id: workspaceRoleId,
        },
        header: { 'If-Match': ifMatch },
      },
      headers: { 'Idempotency-Key': mutationKey() },
    }
  )
  return snapshot(data, response)
}

export function availableDocumentSubteams(
  subteams: readonly DocumentSubteam[],
  state: DocumentRoleGrantsState
): readonly DocumentSubteam[] {
  const granted = new Set(state.grants.map((grant) => grant.workspaceRoleId))
  return subteams.filter((subteam) => !granted.has(subteam.id))
}

export function documentSubteamPermission(
  state: DocumentRoleGrantsState,
  workspaceRoleId: string
): DocumentGrantRole | null {
  return state.grants.find((grant) => grant.workspaceRoleId === workspaceRoleId)?.role ?? null
}

/** Refresh the Share snapshot after a conflict and let the editor review before retrying. */
export function isDocumentRoleGrantConflict(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem && [409, 412, 428].includes(error.status)
}

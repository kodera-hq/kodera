import { ApiProblem, coreApi } from '@/api/client'
import type { components } from '@/api/schema'

export type CoreWorkspaceDocument = components['schemas']['WorkspaceDocument']
export type CoreWorkspaceDocumentRequest = components['schemas']['WorkspaceDocumentRequest']
export type CoreWorkspaceDocumentPatch = components['schemas']['WorkspaceDocumentPatch']
export type CoreDocumentBacklink = components['schemas']['DocumentBacklink']
export type CoreDocumentCollabSession = components['schemas']['DocumentCollabSession']
export type CoreWorkspaceSearchResult = components['schemas']['WorkspaceSearchResult']

export interface WorkspaceDocumentWithEtag {
  readonly document: CoreWorkspaceDocument
  readonly etag: string | null
}

export async function listWorkspaceDocuments(
  organisationId: string,
  signal?: AbortSignal
): Promise<readonly CoreWorkspaceDocument[]> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/documents', {
    params: { path: { organisation_id: organisationId } },
    ...(signal ? { signal } : {}),
  })
  return data?.data ?? []
}

export async function getWorkspaceDocument(
  organisationId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<WorkspaceDocumentWithEtag> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/documents/{document_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
        },
      },
      ...(signal ? { signal } : {}),
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    document: data,
    etag: response.headers.get('ETag'),
  }
}

export async function createWorkspaceDocument(
  organisationId: string,
  body: CoreWorkspaceDocumentRequest
): Promise<WorkspaceDocumentWithEtag> {
  const { data, response } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/documents',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body,
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    document: data,
    etag: response.headers.get('ETag'),
  }
}

export async function updateWorkspaceDocument(
  organisationId: string,
  documentId: string,
  etag: string,
  body: CoreWorkspaceDocumentPatch
): Promise<WorkspaceDocumentWithEtag> {
  const { data, response } = await coreApi().PATCH(
    '/organisations/{organisation_id}/workspace/documents/{document_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
        },
        header: { 'If-Match': etag },
      },
      body,
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    document: data,
    etag: response.headers.get('ETag') ?? etag,
  }
}

export async function deleteWorkspaceDocument(
  organisationId: string,
  documentId: string
): Promise<void> {
  await coreApi().DELETE('/organisations/{organisation_id}/workspace/documents/{document_id}', {
    params: {
      path: {
        organisation_id: organisationId,
        document_id: documentId,
      },
    },
  })
}

export function isNonEmptyParentDeleteError(error: unknown): boolean {
  return error instanceof ApiProblem && error.status === 409
}

export async function listWorkspaceDocumentBacklinks(
  organisationId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<readonly CoreDocumentBacklink[]> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/documents/{document_id}/backlinks',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
        },
      },
      ...(signal ? { signal } : {}),
    }
  )
  return data?.data ?? []
}

export async function createWorkspaceDocumentCollabSession(
  organisationId: string,
  documentId: string
): Promise<CoreDocumentCollabSession> {
  const { data, response } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/documents/{document_id}/collab-session',
    {
      params: {
        path: {
          organisation_id: organisationId,
          document_id: documentId,
        },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return data
}

export async function searchWorkspaceUnified(
  organisationId: string,
  query: string,
  limit = 15,
  signal?: AbortSignal
): Promise<readonly CoreWorkspaceSearchResult[]> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/search', {
    params: {
      path: { organisation_id: organisationId },
      query: { q: query, limit },
    },
    ...(signal ? { signal } : {}),
  })
  return data?.data ?? []
}

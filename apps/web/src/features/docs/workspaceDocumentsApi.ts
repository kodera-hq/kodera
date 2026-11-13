import { ApiProblem, coreApi } from '@/api/client'
import type { components } from '@/api/schema'
import {
  fromWireWorkspaceCollection,
  fromWireWorkspaceCollectionRow,
  toWireCollectionProperty,
  toWireCollectionValue,
  toWireCollectionView,
  toWireWorkspaceCollectionRowValues,
  type CollectionCellValue,
  type CollectionFilterRule,
  type CollectionPropertyDef,
  type CollectionSortRule,
  type CollectionViewConfig,
  type WorkspaceCollectionModel,
  type WorkspaceCollectionRowModel,
} from './collectionSchema'

export type CoreWorkspaceDocument = components['schemas']['WorkspaceDocument']
export type CoreWorkspaceDocumentRequest = components['schemas']['WorkspaceDocumentRequest']
export type CoreWorkspaceDocumentPatch = components['schemas']['WorkspaceDocumentPatch']
export type CoreDocumentBacklink = components['schemas']['DocumentBacklink']
export type CoreDocumentCollabSession = components['schemas']['DocumentCollabSession']
export type CoreWorkspaceSearchResult = components['schemas']['WorkspaceSearchResult']
export type CoreWorkspaceCollection = components['schemas']['WorkspaceCollection']
export type CoreWorkspaceCollectionRequest = components['schemas']['WorkspaceCollectionRequest']
export type CoreWorkspaceCollectionPatch = components['schemas']['WorkspaceCollectionPatch']
export type CoreWorkspaceCollectionRow = components['schemas']['WorkspaceCollectionRow']
export type CoreWorkspaceCollectionRowRequest =
  components['schemas']['WorkspaceCollectionRowRequest']
export type CoreCollectionQuery = components['schemas']['CollectionQuery']

export interface WorkspaceDocumentWithEtag {
  readonly document: CoreWorkspaceDocument
  readonly etag: string | null
}

export interface WorkspaceCollectionWithEtag {
  readonly collection: WorkspaceCollectionModel
  readonly etag: string | null
}

export interface WorkspaceCollectionListPage {
  readonly collections: readonly WorkspaceCollectionModel[]
  readonly etag: string | null
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface WorkspaceCollectionQueryPage {
  readonly rows: readonly WorkspaceCollectionRowModel[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface WorkspaceCollectionRowWithEtag {
  readonly row: WorkspaceCollectionRowModel
  readonly etag: string | null
  readonly created: boolean
}

export type CollectionRowWritePrecondition =
  | { readonly mode: 'update'; readonly ifMatch: string }
  | { readonly mode: 'create'; readonly ifNoneMatch: '*' }

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

/**
 * A title or parent change, re-read once on 412. Every realtime commit bumps the document's
 * revision and so its tag, so the tag a tab read on open is stale after the first keystroke
 * anyone makes; without the re-read every rename during a live session failed. Markdown is never
 * retried blind: overwriting a body edited since the read would discard someone's text.
 */
export async function updateWorkspaceDocumentMetadata(
  organisationId: string,
  documentId: string,
  etag: string,
  body: Omit<CoreWorkspaceDocumentPatch, 'markdown'>,
  io: { update?: typeof updateWorkspaceDocument; get?: typeof getWorkspaceDocument } = {}
): Promise<WorkspaceDocumentWithEtag> {
  const update = io.update ?? updateWorkspaceDocument
  const get = io.get ?? getWorkspaceDocument
  try {
    return await update(organisationId, documentId, etag, body)
  } catch (error) {
    if (!(error instanceof ApiProblem) || error.status !== 412) throw error
    const fresh = await get(organisationId, documentId)
    if (!fresh.etag) throw error
    return update(organisationId, documentId, fresh.etag, body)
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

export function isCollectionPreconditionFailedError(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem && error.status === 412
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

/**
 * Core 0.44.0 Workspace Collections & Rows API
 *
 * `openapi-typescript` emits schema-name discriminators (`CollectionSelectProperty`) where the
 * OpenAPI 3.1 contract declares `const: select | table | ...` without an explicit `mapping` block.
 * Wire adapters in `collectionSchema.ts` emit the canonical OpenAPI `const` values on write and
 * accept both forms on read.
 */
export async function listWorkspaceCollections(
  organisationId: string,
  options?: {
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
    readonly signal?: AbortSignal | undefined
  }
): Promise<WorkspaceCollectionListPage> {
  const query =
    options?.cursor !== undefined || options?.limit !== undefined
      ? {
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }
      : undefined
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/collections',
    {
      params: {
        path: { organisation_id: organisationId },
        ...(query ? { query } : {}),
      },
      ...(options?.signal ? { signal: options.signal } : {}),
    }
  )
  const items = (data?.data ?? []).map((item) =>
    fromWireWorkspaceCollection(item as unknown as Parameters<typeof fromWireWorkspaceCollection>[0])
  )
  return {
    collections: items,
    etag: response.headers.get('ETag'),
    nextCursor: data?.next_cursor ?? null,
    hasMore: Boolean(data?.has_more),
  }
}

export async function getWorkspaceCollection(
  organisationId: string,
  collectionId: string,
  signal?: AbortSignal
): Promise<WorkspaceCollectionWithEtag> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
        },
      },
      ...(signal ? { signal } : {}),
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    collection: fromWireWorkspaceCollection(
      data as unknown as Parameters<typeof fromWireWorkspaceCollection>[0]
    ),
    etag: response.headers.get('ETag'),
  }
}

export async function createWorkspaceCollection(
  organisationId: string,
  input: {
    readonly title: string
    readonly properties: readonly CollectionPropertyDef[]
    readonly views: readonly CollectionViewConfig[]
  },
  idempotencyKey?: string
): Promise<WorkspaceCollectionWithEtag> {
  const wireBody = {
    title: input.title,
    properties: input.properties.map(toWireCollectionProperty),
    views: input.views.map(toWireCollectionView),
  } as unknown as CoreWorkspaceCollectionRequest

  const { data, response } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/collections',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey ?? crypto.randomUUID() },
      },
      body: wireBody,
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    collection: fromWireWorkspaceCollection(
      data as unknown as Parameters<typeof fromWireWorkspaceCollection>[0]
    ),
    etag: response.headers.get('ETag'),
  }
}

export async function updateWorkspaceCollection(
  organisationId: string,
  collectionId: string,
  etag: string,
  patch: {
    readonly title?: string | undefined
    readonly properties?: readonly CollectionPropertyDef[] | undefined
    readonly views?: readonly CollectionViewConfig[] | undefined
  }
): Promise<WorkspaceCollectionWithEtag> {
  const wireBody = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.properties !== undefined
      ? { properties: patch.properties.map(toWireCollectionProperty) }
      : {}),
    ...(patch.views !== undefined ? { views: patch.views.map(toWireCollectionView) } : {}),
  } as unknown as CoreWorkspaceCollectionPatch

  const { data, response } = await coreApi().PATCH(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
        },
        header: { 'If-Match': etag },
      },
      body: wireBody,
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    collection: fromWireWorkspaceCollection(
      data as unknown as Parameters<typeof fromWireWorkspaceCollection>[0]
    ),
    etag: response.headers.get('ETag') ?? etag,
  }
}

export async function deleteWorkspaceCollection(
  organisationId: string,
  collectionId: string
): Promise<void> {
  await coreApi().DELETE(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
        },
      },
    }
  )
}

export async function queryWorkspaceCollection(
  organisationId: string,
  collectionId: string,
  queryBody: {
    readonly viewId?: string | undefined
    readonly filters?: readonly CollectionFilterRule[] | undefined
    readonly sorts?: readonly CollectionSortRule[] | undefined
  },
  properties: readonly CollectionPropertyDef[] = [],
  options?: {
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
    readonly idempotencyKey?: string | undefined
    readonly signal?: AbortSignal | undefined
  }
): Promise<WorkspaceCollectionQueryPage> {
  const wireQuery = {
    ...(queryBody.viewId !== undefined ? { viewId: queryBody.viewId } : {}),
    ...(queryBody.filters !== undefined
      ? {
          filters: queryBody.filters.map((f) => ({
            propertyId: f.propertyId,
            operator: f.operator,
            ...(f.value ? { value: toWireCollectionValue(f.value) } : {}),
          })),
        }
      : {}),
    ...(queryBody.sorts !== undefined ? { sorts: queryBody.sorts } : {}),
  } as unknown as CoreCollectionQuery

  const pagination =
    options?.cursor !== undefined || options?.limit !== undefined
      ? {
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }
      : undefined

  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}/query',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
        },
        header: { 'Idempotency-Key': options?.idempotencyKey ?? crypto.randomUUID() },
        ...(pagination ? { query: pagination } : {}),
      },
      body: wireQuery,
      ...(options?.signal ? { signal: options.signal } : {}),
    }
  )
  const rows = (data?.data ?? []).map((item) =>
    fromWireWorkspaceCollectionRow(
      item as unknown as Parameters<typeof fromWireWorkspaceCollectionRow>[0],
      properties
    )
  )
  return {
    rows,
    nextCursor: data?.next_cursor ?? null,
    hasMore: Boolean(data?.has_more),
  }
}

export async function getWorkspaceCollectionRow(
  organisationId: string,
  collectionId: string,
  documentId: string,
  properties: readonly CollectionPropertyDef[] = [],
  signal?: AbortSignal
): Promise<WorkspaceCollectionRowWithEtag> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
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
    row: fromWireWorkspaceCollectionRow(
      data as unknown as Parameters<typeof fromWireWorkspaceCollectionRow>[0],
      properties
    ),
    etag: response.headers.get('ETag'),
    created: false,
  }
}

/**
 * Replaces typed collection row values with strict conditional headers (Core 0.44.0):
 * - `mode: 'update'` sends `If-Match: <etag>` (refuses empty or `*`).
 * - `mode: 'create'` sends `If-None-Match: *` (`201 Created`).
 */
export async function putWorkspaceCollectionRow(
  organisationId: string,
  collectionId: string,
  documentId: string,
  values: Readonly<Record<string, CollectionCellValue>>,
  precondition: CollectionRowWritePrecondition,
  properties: readonly CollectionPropertyDef[] = []
): Promise<WorkspaceCollectionRowWithEtag> {
  if (precondition.mode === 'update') {
    const trimmed = precondition.ifMatch.trim()
    if (trimmed.length === 0 || trimmed === '*') {
      throw new RangeError('putWorkspaceCollectionRow requires a non-wildcard ETag for If-Match.')
    }
  }

  const header =
    precondition.mode === 'update'
      ? { 'If-Match': precondition.ifMatch }
      : { 'If-None-Match': '*' as const }

  const wireBody = {
    values: toWireWorkspaceCollectionRowValues(values),
  } as unknown as CoreWorkspaceCollectionRowRequest

  const { data, response } = await coreApi().PUT(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
          document_id: documentId,
        },
        header,
      },
      body: wireBody,
    }
  )
  if (data === undefined) {
    throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
  }
  return {
    row: fromWireWorkspaceCollectionRow(
      data as unknown as Parameters<typeof fromWireWorkspaceCollectionRow>[0],
      properties
    ),
    etag: response.headers.get('ETag'),
    created: response.status === 201,
  }
}

export async function deleteWorkspaceCollectionRow(
  organisationId: string,
  collectionId: string,
  documentId: string
): Promise<void> {
  await coreApi().DELETE(
    '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}',
    {
      params: {
        path: {
          organisation_id: organisationId,
          collection_id: collectionId,
          document_id: documentId,
        },
      },
    }
  )
}

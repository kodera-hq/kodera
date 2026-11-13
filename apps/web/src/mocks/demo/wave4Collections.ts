// Demo MSW handlers for Core API 0.44.0 lightweight workspace collections and typed rows.
// Seeds an isolated per-organisation collection backed by the demo workspace documents so the
// walkable Groupe Vercelli and community demos answer every collection route without falling
// through to generated contract example fixtures.

import { http, HttpResponse, type HttpHandler } from 'msw'
import {
  createDefaultCollectionSchema,
  toWireCollectionProperty,
  toWireCollectionView,
  toWireWorkspaceCollectionRowValues,
} from '@/features/docs/collectionSchema'
import { problem } from '../problem'

export const WAVE4_COLLECTIONS_DEMO_ROUTES: readonly string[] = [
  'GET /organisations/:organisation_id/workspace/collections',
  'POST /organisations/:organisation_id/workspace/collections',
  'GET /organisations/:organisation_id/workspace/collections/:collection_id',
  'PATCH /organisations/:organisation_id/workspace/collections/:collection_id',
  'DELETE /organisations/:organisation_id/workspace/collections/:collection_id',
  'POST /organisations/:organisation_id/workspace/collections/:collection_id/query',
  'GET /organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id',
  'PUT /organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id',
  'DELETE /organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id',
]

interface StoredDemoCollection {
  id: string
  title: string
  properties: unknown[]
  views: unknown[]
  role: 'editor' | 'viewer'
  updatedAt: string
  version: number
}

interface StoredDemoCollectionRow {
  documentId: string
  values: Record<string, unknown>
  updatedAt: string
  version: number
}

interface OrgCollectionsStore {
  collections: StoredDemoCollection[]
  rowsByCollection: Map<string, Map<string, StoredDemoCollectionRow>>
}

const DEMO_COLLECTION_ID = '5eed0009-0000-4000-8000-000000000001'
const DOC_ROOT_ID = '5eed0008-0000-4000-8000-000000000001'
const DOC_RUNBOOK_ID = '5eed0008-0000-4000-8000-000000000002'

const storeByOrg = new Map<string, OrgCollectionsStore>()

function collectionEtag(col: StoredDemoCollection): string {
  return `"col-${col.id}-v${col.version}"`
}

function rowEtag(row: StoredDemoCollectionRow): string {
  return `"row-${row.documentId}-v${row.version}"`
}

function toWireCollection(col: StoredDemoCollection) {
  return {
    id: col.id,
    title: col.title,
    properties: col.properties,
    views: col.views,
    role: col.role,
    updatedAt: col.updatedAt,
  }
}

function toWireRow(row: StoredDemoCollectionRow) {
  return {
    documentId: row.documentId,
    values: row.values,
    updatedAt: row.updatedAt,
  }
}

function ensureOrgStore(orgId: string): OrgCollectionsStore {
  const existing = storeByOrg.get(orgId)
  if (existing) return existing

  const stamp = new Date().toISOString()
  const schema = createDefaultCollectionSchema('fr')
  const seededCollection: StoredDemoCollection = {
    id: DEMO_COLLECTION_ID,
    title: schema.title,
    properties: schema.properties.map(toWireCollectionProperty),
    views: schema.views.map(toWireCollectionView),
    role: 'editor',
    updatedAt: stamp,
    version: 1,
  }

  const rows = new Map<string, StoredDemoCollectionRow>()
  rows.set(DOC_ROOT_ID, {
    documentId: DOC_ROOT_ID,
    values: toWireWorkspaceCollectionRowValues({
      status: { kind: 'status', value: 'done' },
      priority: { kind: 'priority', value: 'high' },
      due_date: { kind: 'due_date', value: '2026-11-20' },
      estimate: { kind: 'number', value: 5 },
      verified: { kind: 'checkbox', value: true },
      tags: { kind: 'tags', value: ['ops', 'spec'] },
    }),
    updatedAt: stamp,
    version: 1,
  })
  rows.set(DOC_RUNBOOK_ID, {
    documentId: DOC_RUNBOOK_ID,
    values: toWireWorkspaceCollectionRowValues({
      status: { kind: 'status', value: 'in_progress' },
      priority: { kind: 'priority', value: 'urgent' },
      due_date: { kind: 'due_date', value: '2026-11-25' },
      estimate: { kind: 'number', value: 3 },
      verified: { kind: 'checkbox', value: false },
      tags: { kind: 'tags', value: ['ops', 'security'] },
    }),
    updatedAt: stamp,
    version: 1,
  })

  const rowsByCollection = new Map<string, Map<string, StoredDemoCollectionRow>>()
  rowsByCollection.set(DEMO_COLLECTION_ID, rows)

  const created: OrgCollectionsStore = {
    collections: [seededCollection],
    rowsByCollection,
  }
  storeByOrg.set(orgId, created)
  return created
}

export function wave4CollectionsDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  return [
    http.get(`${base}/organisations/:organisation_id/workspace/collections`, ({ params }) => {
      const orgId = String(params['organisation_id'])
      const store = ensureOrgStore(orgId)
      return HttpResponse.json(
        {
          data: store.collections.map(toWireCollection),
          next_cursor: null,
          has_more: false,
        },
        { headers: headers() }
      )
    }),

    http.post(
      `${base}/organisations/:organisation_id/workspace/collections`,
      async ({ params, request }) => {
        const orgId = String(params['organisation_id'])
        const store = ensureOrgStore(orgId)
        const body = (await request.json().catch(() => ({}))) as {
          title?: string
          properties?: unknown[]
          views?: unknown[]
        }
        const created: StoredDemoCollection = {
          id: crypto.randomUUID(),
          title: (body.title ?? '').trim() || 'Suivi des pages',
          properties: Array.isArray(body.properties) ? body.properties : [],
          views: Array.isArray(body.views) ? body.views : [],
          role: 'editor',
          updatedAt: new Date().toISOString(),
          version: 1,
        }
        store.collections.push(created)
        store.rowsByCollection.set(created.id, new Map())
        return HttpResponse.json(toWireCollection(created), {
          status: 201,
          headers: { ...headers(), ETag: collectionEtag(created) },
        })
      }
    ),

    http.get(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const found = ensureOrgStore(orgId).collections.find((c) => c.id === colId)
        if (!found) return problem('https://kodera.io/problems/not-found')
        return HttpResponse.json(toWireCollection(found), {
          headers: { ...headers(), ETag: collectionEtag(found) },
        })
      }
    ),

    http.patch(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id`,
      async ({ params, request }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const found = ensureOrgStore(orgId).collections.find((c) => c.id === colId)
        if (!found) return problem('https://kodera.io/problems/not-found')

        const ifMatch = request.headers.get('If-Match')
        if (!ifMatch) return problem('https://kodera.io/problems/precondition-required')
        if (ifMatch !== collectionEtag(found)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: collectionEtag(found),
          })
        }

        const patch = (await request.json().catch(() => ({}))) as {
          title?: string
          properties?: unknown[]
          views?: unknown[]
        }
        if (typeof patch.title === 'string' && patch.title.trim().length > 0) {
          found.title = patch.title.trim()
        }
        if (Array.isArray(patch.properties)) {
          found.properties = patch.properties
        }
        if (Array.isArray(patch.views)) {
          found.views = patch.views
        }
        found.updatedAt = new Date().toISOString()
        found.version += 1

        return HttpResponse.json(toWireCollection(found), {
          headers: { ...headers(), ETag: collectionEtag(found) },
        })
      }
    ),

    http.delete(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const store = ensureOrgStore(orgId)
        const idx = store.collections.findIndex((c) => c.id === colId)
        if (idx === -1) return problem('https://kodera.io/problems/not-found')
        store.collections.splice(idx, 1)
        store.rowsByCollection.delete(colId)
        return new HttpResponse(null, { status: 204, headers: headers() })
      }
    ),

    http.post(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id/query`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const store = ensureOrgStore(orgId)
        if (!store.collections.some((c) => c.id === colId)) {
          return problem('https://kodera.io/problems/not-found')
        }
        const rows = [...(store.rowsByCollection.get(colId)?.values() ?? [])].map(toWireRow)
        return HttpResponse.json(
          { data: rows, next_cursor: null, has_more: false },
          { headers: headers() }
        )
      }
    ),

    http.get(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const docId = String(params['document_id'])
        const store = ensureOrgStore(orgId)
        const row = store.rowsByCollection.get(colId)?.get(docId)
        if (!row) return problem('https://kodera.io/problems/not-found')
        return HttpResponse.json(toWireRow(row), {
          headers: { ...headers(), ETag: rowEtag(row) },
        })
      }
    ),

    http.put(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id`,
      async ({ params, request }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const docId = String(params['document_id'])
        const store = ensureOrgStore(orgId)
        if (!store.collections.some((c) => c.id === colId)) {
          return problem('https://kodera.io/problems/not-found')
        }
        let rows = store.rowsByCollection.get(colId)
        if (!rows) {
          rows = new Map()
          store.rowsByCollection.set(colId, rows)
        }

        const ifMatch = request.headers.get('If-Match')
        const ifNoneMatch = request.headers.get('If-None-Match')
        if (!ifMatch && !ifNoneMatch) {
          return problem('https://kodera.io/problems/precondition-required')
        }
        if ((ifMatch && ifNoneMatch) || ifMatch === '*') {
          return problem('https://kodera.io/problems/validation-error')
        }

        const existing = rows.get(docId)
        if (ifNoneMatch === '*') {
          if (existing) {
            return problem('https://kodera.io/problems/precondition-failed', {
              currentEtag: rowEtag(existing),
            })
          }
          const body = (await request.json().catch(() => ({}))) as {
            values?: Record<string, unknown>
          }
          const created: StoredDemoCollectionRow = {
            documentId: docId,
            values: body.values ?? {},
            updatedAt: new Date().toISOString(),
            version: 1,
          }
          rows.set(docId, created)
          return HttpResponse.json(toWireRow(created), {
            status: 201,
            headers: { ...headers(), ETag: rowEtag(created) },
          })
        }

        if (!existing) {
          return problem('https://kodera.io/problems/precondition-failed')
        }
        if (ifMatch !== rowEtag(existing)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: rowEtag(existing),
          })
        }

        const body = (await request.json().catch(() => ({}))) as {
          values?: Record<string, unknown>
        }
        existing.values = body.values ?? {}
        existing.updatedAt = new Date().toISOString()
        existing.version += 1

        return HttpResponse.json(toWireRow(existing), {
          status: 200,
          headers: { ...headers(), ETag: rowEtag(existing) },
        })
      }
    ),

    http.delete(
      `${base}/organisations/:organisation_id/workspace/collections/:collection_id/rows/:document_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const colId = String(params['collection_id'])
        const docId = String(params['document_id'])
        const rows = ensureOrgStore(orgId).rowsByCollection.get(colId)
        if (!rows || !rows.has(docId)) {
          return problem('https://kodera.io/problems/not-found')
        }
        rows.delete(docId)
        return new HttpResponse(null, { status: 204, headers: headers() })
      }
    ),
  ]
}

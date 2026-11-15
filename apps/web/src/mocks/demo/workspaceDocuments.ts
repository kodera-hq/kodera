// Demo MSW handlers for Core API 0.43.0 collaborative workspace documents, backlinks,
// collab-session, and unified workspace search. Keeps an isolated in-memory page tree per
// organisation so the walkable demo and E2E suites answer every route the console calls without
// falling through to OpenAPI example fixtures or opening external WebSockets.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components } from '@/api/schema'
import {
  canCreateDocumentUnderParent,
  canReparentDocument,
  getDocumentStarterTemplate,
  type DocumentTemplateKey,
} from '@/features/docs/pageTree'
import { computeLocalBacklinks } from '@/features/docs/wikilinks'
import { problem } from '../problem'

type WorkspaceDocument = components['schemas']['WorkspaceDocument']
type WorkspaceDocumentRequest = components['schemas']['WorkspaceDocumentRequest']
type WorkspaceDocumentPatch = components['schemas']['WorkspaceDocumentPatch']
type WorkspaceSearchResult = components['schemas']['WorkspaceSearchResult']

export const WORKSPACE_DOCS_DEMO_ROUTES: readonly string[] = [
  'GET /organisations/:organisation_id/workspace/documents',
  'POST /organisations/:organisation_id/workspace/documents',
  'GET /organisations/:organisation_id/workspace/documents/:document_id',
  'PATCH /organisations/:organisation_id/workspace/documents/:document_id',
  'DELETE /organisations/:organisation_id/workspace/documents/:document_id',
  'GET /organisations/:organisation_id/workspace/documents/:document_id/backlinks',
  'POST /organisations/:organisation_id/workspace/documents/:document_id/collab-session',
  'GET /organisations/:organisation_id/workspace/search',
]

interface StoredDemoDoc extends WorkspaceDocument {
  version: number
}

const DOC_ROOT_ID = '5eed0008-0000-4000-8000-000000000001'
const DOC_RUNBOOK_ID = '5eed0008-0000-4000-8000-000000000002'

const docsByOrg = new Map<string, StoredDemoDoc[]>()

function etagOf(doc: StoredDemoDoc): string {
  return `"doc-${doc.id}-v${doc.version}"`
}

function toWireDocument(doc: StoredDemoDoc): WorkspaceDocument {
  return {
    id: doc.id,
    parentId: doc.parentId,
    title: doc.title,
    markdown: doc.markdown,
    role: doc.role,
    updatedAt: doc.updatedAt,
  }
}

function ensureOrgDocs(orgId: string): StoredDemoDoc[] {
  const existing = docsByOrg.get(orgId)
  if (existing) return existing
  const stamp = new Date().toISOString()
  const seeded: StoredDemoDoc[] = [
    {
      id: DOC_ROOT_ID,
      parentId: null,
      title: 'Architecture & Exploitation',
      markdown:
        '## Vue d’ensemble\n\nRéférentiel technique de l’espace et lien vers [[Procédure d’astreinte]].',
      role: 'editor',
      updatedAt: stamp,
      version: 1,
    },
    {
      id: DOC_RUNBOOK_ID,
      parentId: DOC_ROOT_ID,
      title: 'Procédure d’astreinte',
      markdown:
        '## Vérifications\n\n- [ ] Contrôler la télémétrie\n- [ ] Consulter [[Architecture & Exploitation]]',
      role: 'editor',
      updatedAt: stamp,
      version: 1,
    },
  ]
  docsByOrg.set(orgId, seeded)
  return seeded
}

export function workspaceDocumentsDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  return [
    http.get(`${base}/organisations/:organisation_id/workspace/documents`, ({ params }) => {
      const orgId = String(params['organisation_id'])
      const docs = ensureOrgDocs(orgId).map(toWireDocument)
      return HttpResponse.json(
        { data: docs, next_cursor: null, has_more: false },
        { headers: headers() }
      )
    }),

    http.post(
      `${base}/organisations/:organisation_id/workspace/documents`,
      async ({ params, request }) => {
        const orgId = String(params['organisation_id'])
        const docs = ensureOrgDocs(orgId)
        const body = (await request.json().catch(() => ({}))) as Partial<WorkspaceDocumentRequest>
        const parentId = body.parentId ?? null

        if (!canCreateDocumentUnderParent(docs, parentId).ok) {
          return problem('https://kodera.io/problems/validation-error', {
            detail: 'Maximum document nesting depth exceeded.',
          })
        }

        const tplKey: DocumentTemplateKey = body.templateKey ?? 'blank'
        const tpl = getDocumentStarterTemplate(tplKey, 'fr')
        const created: StoredDemoDoc = {
          id: crypto.randomUUID(),
          parentId,
          title: (body.title ?? tpl.defaultTitle).trim() || tpl.defaultTitle,
          markdown: tpl.markdown,
          role: 'editor',
          updatedAt: new Date().toISOString(),
          version: 1,
        }
        docs.push(created)
        return HttpResponse.json(toWireDocument(created), {
          status: 201,
          headers: { ...headers(), ETag: etagOf(created) },
        })
      }
    ),

    http.get(
      `${base}/organisations/:organisation_id/workspace/documents/:document_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const docId = String(params['document_id'])
        const found = ensureOrgDocs(orgId).find((d) => d.id === docId)
        if (!found) return problem('https://kodera.io/problems/not-found')
        return HttpResponse.json(toWireDocument(found), {
          headers: { ...headers(), ETag: etagOf(found) },
        })
      }
    ),

    http.patch(
      `${base}/organisations/:organisation_id/workspace/documents/:document_id`,
      async ({ params, request }) => {
        const orgId = String(params['organisation_id'])
        const docId = String(params['document_id'])
        const docs = ensureOrgDocs(orgId)
        const found = docs.find((d) => d.id === docId)
        if (!found) return problem('https://kodera.io/problems/not-found')

        const ifMatch = request.headers.get('If-Match')
        if (!ifMatch) {
          return problem('https://kodera.io/problems/precondition-required')
        }
        if (ifMatch !== etagOf(found)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: etagOf(found),
          })
        }

        const patch = (await request.json().catch(() => ({}))) as WorkspaceDocumentPatch
        if (patch.parentId !== undefined && patch.parentId !== found.parentId) {
          const check = canReparentDocument(docs, docId, patch.parentId)
          if (!check.ok) {
            return problem('https://kodera.io/problems/conflict')
          }
          found.parentId = patch.parentId
        }
        if (typeof patch.title === 'string' && patch.title.trim().length > 0) {
          found.title = patch.title
        }
        if (typeof patch.markdown === 'string') {
          found.markdown = patch.markdown
        }
        found.updatedAt = new Date().toISOString()
        found.version += 1

        return HttpResponse.json(toWireDocument(found), {
          headers: { ...headers(), ETag: etagOf(found) },
        })
      }
    ),

    http.delete(
      `${base}/organisations/:organisation_id/workspace/documents/:document_id`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const docId = String(params['document_id'])
        const docs = ensureOrgDocs(orgId)
        const idx = docs.findIndex((d) => d.id === docId)
        if (idx === -1) return problem('https://kodera.io/problems/not-found')
        if (docs.some((d) => d.parentId === docId)) {
          return problem('https://kodera.io/problems/conflict')
        }
        docs.splice(idx, 1)
        return new HttpResponse(null, { status: 204, headers: headers() })
      }
    ),

    http.get(
      `${base}/organisations/:organisation_id/workspace/documents/:document_id/backlinks`,
      ({ params }) => {
        const orgId = String(params['organisation_id'])
        const docId = String(params['document_id'])
        const docs = ensureOrgDocs(orgId)
        if (!docs.some((d) => d.id === docId)) {
          return problem('https://kodera.io/problems/not-found')
        }
        const backlinks = computeLocalBacklinks(
          docs.map((d) => ({ id: d.id, title: d.title, content: d.markdown })),
          docId
        )
        return HttpResponse.json(
          { data: backlinks, next_cursor: null, has_more: false },
          { headers: headers() }
        )
      }
    ),

    // Demo MSW runs without a live Yjs WebSocket relay; 404 keeps the editor in local IndexedDB mode.
    http.post(
      `${base}/organisations/:organisation_id/workspace/documents/:document_id/collab-session`,
      () => problem('https://kodera.io/problems/not-found')
    ),

    http.get(`${base}/organisations/:organisation_id/workspace/search`, ({ params, request }) => {
      const orgId = String(params['organisation_id'])
      const url = new URL(request.url)
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? '15') || 15))
      const docs = ensureOrgDocs(orgId)
      const results: WorkspaceSearchResult[] = docs
        .filter(
          (d) =>
            q.length === 0 ||
            d.title.toLowerCase().includes(q) ||
            d.markdown.toLowerCase().includes(q)
        )
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          kind: 'document',
          title: d.title,
          excerpt: d.markdown.slice(0, 120),
        }))
      return HttpResponse.json(
        { data: results, next_cursor: null, has_more: false },
        { headers: headers() }
      )
    }),
  ]
}

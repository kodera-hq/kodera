export const MAX_DOCUMENT_TREE_DEPTH = 16

export type WorkspaceCoreTemplateKey = 'spec' | 'adr' | 'meeting_notes' | 'runbook'
export type DocumentTemplateKey = 'blank' | WorkspaceCoreTemplateKey
export type DocumentAccessRole = 'editor' | 'viewer'

export interface PageTreeItem {
  readonly id: string
  readonly title: string
  readonly parentId?: string | null | undefined
  readonly order?: number | undefined
}

export interface DocumentTreeNode<T extends PageTreeItem = PageTreeItem> {
  readonly doc: T
  /** 1-indexed depth (`1` = root page, `16` = maximum allowed depth). */
  readonly depth: number
  readonly hasChildren: boolean
  readonly childCount: number
  readonly siblingIndex: number
  readonly siblingCount: number
  /** Ancestor + self titles from root to this node. */
  readonly pathTitles: readonly string[]
}

export type TreeMutationFailureReason =
  | 'document_not_found'
  | 'parent_not_found'
  | 'cycle_detected'
  | 'max_depth_exceeded'
  | 'has_children'

export type TreeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TreeMutationFailureReason }

export type TreeMutationResult<T extends PageTreeItem> =
  | { readonly ok: true; readonly docs: readonly T[] }
  | { readonly ok: false; readonly reason: TreeMutationFailureReason }

function normalizedParentId(parentId: string | null | undefined): string | null {
  return typeof parentId === 'string' && parentId.length > 0 ? parentId : null
}

/**
 * Computes the 1-indexed depth of `documentId` within `docs`.
 * Guarded against malformed cyclic inputs so it always terminates.
 */
export function getDocumentDepth(
  docs: readonly PageTreeItem[],
  documentId: string
): number | null {
  const byId = new Map<string, PageTreeItem>(docs.map((doc) => [doc.id, doc]))
  const start = byId.get(documentId)
  if (!start) return null

  let depth = 1
  const visited = new Set<string>([documentId])
  let cursor = normalizedParentId(start.parentId)

  while (cursor !== null) {
    if (visited.has(cursor)) return null
    const parent = byId.get(cursor)
    if (!parent) break
    visited.add(cursor)
    depth += 1
    cursor = normalizedParentId(parent.parentId)
  }

  return depth
}

/**
 * Computes the maximum subtree height rooted at `documentId` (`1` for a leaf page).
 */
export function getSubtreeHeight(docs: readonly PageTreeItem[], documentId: string): number {
  const childrenByParent = new Map<string, PageTreeItem[]>()
  for (const doc of docs) {
    const pid = normalizedParentId(doc.parentId)
    if (pid !== null) {
      const bucket = childrenByParent.get(pid)
      if (bucket) bucket.push(doc)
      else childrenByParent.set(pid, [doc])
    }
  }

  const visited = new Set<string>()
  const measure = (id: string): number => {
    if (visited.has(id)) return 1
    visited.add(id)
    const children = childrenByParent.get(id) ?? []
    let maxChild = 0
    for (const child of children) {
      const childHeight = measure(child.id)
      if (childHeight > maxChild) maxChild = childHeight
    }
    return 1 + maxChild
  }

  return measure(documentId)
}

/**
 * Validates creating a new child document under `parentId` against `MAX_DOCUMENT_TREE_DEPTH` (16).
 */
export function canCreateDocumentUnderParent(
  docs: readonly PageTreeItem[],
  parentId: string | null | undefined
): TreeValidationResult {
  const targetParent = normalizedParentId(parentId)
  if (targetParent === null) return { ok: true }

  const parentDepth = getDocumentDepth(docs, targetParent)
  if (parentDepth === null) {
    return { ok: false, reason: 'parent_not_found' }
  }
  if (parentDepth + 1 > MAX_DOCUMENT_TREE_DEPTH) {
    return { ok: false, reason: 'max_depth_exceeded' }
  }
  return { ok: true }
}

/**
 * Validates moving `documentId` under `nextParentId`:
 * - refuses missing target document or missing parent;
 * - refuses self-parenting and ancestor->descendant cycles;
 * - refuses moves where `parentDepth + subtreeHeight > MAX_DOCUMENT_TREE_DEPTH` (16).
 */
export function canReparentDocument(
  docs: readonly PageTreeItem[],
  documentId: string,
  nextParentId: string | null | undefined
): TreeValidationResult {
  const byId = new Map<string, PageTreeItem>(docs.map((doc) => [doc.id, doc]))
  if (!byId.has(documentId)) {
    return { ok: false, reason: 'document_not_found' }
  }

  const targetParent = normalizedParentId(nextParentId)
  if (targetParent === documentId) {
    return { ok: false, reason: 'cycle_detected' }
  }

  if (targetParent !== null) {
    if (!byId.has(targetParent)) {
      return { ok: false, reason: 'parent_not_found' }
    }
    let cursor: string | null = targetParent
    const visited = new Set<string>()
    while (cursor !== null) {
      if (cursor === documentId) {
        return { ok: false, reason: 'cycle_detected' }
      }
      if (visited.has(cursor)) {
        return { ok: false, reason: 'cycle_detected' }
      }
      visited.add(cursor)
      const node = byId.get(cursor)
      cursor = node ? normalizedParentId(node.parentId) : null
    }
  }

  const targetParentDepth = targetParent === null ? 0 : getDocumentDepth(docs, targetParent)
  if (targetParentDepth === null) {
    return { ok: false, reason: 'cycle_detected' }
  }

  const subtreeHeight = getSubtreeHeight(docs, documentId)
  if (targetParentDepth + subtreeHeight > MAX_DOCUMENT_TREE_DEPTH) {
    return { ok: false, reason: 'max_depth_exceeded' }
  }

  return { ok: true }
}

/**
 * Matches Core 0.43.0 `DELETE /workspace/documents/{id}` (`409` when child pages exist).
 */
export function canDeleteDocument(
  docs: readonly PageTreeItem[],
  documentId: string
): TreeValidationResult {
  const exists = docs.some((doc) => doc.id === documentId)
  if (!exists) return { ok: false, reason: 'document_not_found' }
  const hasChildren = docs.some((doc) => normalizedParentId(doc.parentId) === documentId)
  if (hasChildren) return { ok: false, reason: 'has_children' }
  return { ok: true }
}

function sortSiblings<T extends PageTreeItem>(
  items: readonly T[],
  indexById: ReadonlyMap<string, number>
): T[] {
  return [...items].sort((a, b) => {
    const orderA = a.order ?? indexById.get(a.id) ?? 0
    const orderB = b.order ?? indexById.get(b.id) ?? 0
    if (orderA !== orderB) return orderA - orderB
    return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0)
  })
}

/**
 * Builds a deterministic flattened page tree in depth-first pre-order.
 * Orphaned documents (whose `parentId` is absent from `docs`) attach cleanly at root level.
 */
export function buildDocumentTree<T extends PageTreeItem>(
  docs: readonly T[]
): DocumentTreeNode<T>[] {
  const byId = new Map<string, T>(docs.map((doc) => [doc.id, doc]))
  const indexById = new Map<string, number>(docs.map((doc, idx) => [doc.id, idx]))
  const childrenByParent = new Map<string | null, T[]>()

  for (const doc of docs) {
    const rawParent = normalizedParentId(doc.parentId)
    const effectiveParent = rawParent !== null && byId.has(rawParent) && rawParent !== doc.id ? rawParent : null
    const list = childrenByParent.get(effectiveParent)
    if (list) list.push(doc)
    else childrenByParent.set(effectiveParent, [doc])
  }

  const result: DocumentTreeNode<T>[] = []
  const visited = new Set<string>()

  const walk = (parentId: string | null, depth: number, ancestorTitles: readonly string[]) => {
    const siblings = sortSiblings(childrenByParent.get(parentId) ?? [], indexById)
    for (let i = 0; i < siblings.length; i += 1) {
      const doc = siblings[i]
      if (!doc || visited.has(doc.id)) continue
      visited.add(doc.id)
      const directChildren = childrenByParent.get(doc.id) ?? []
      const pathTitles = [...ancestorTitles, doc.title]
      result.push({
        doc,
        depth,
        hasChildren: directChildren.length > 0,
        childCount: directChildren.length,
        siblingIndex: i,
        siblingCount: siblings.length,
        pathTitles,
      })
      if (depth < MAX_DOCUMENT_TREE_DEPTH) {
        walk(doc.id, depth + 1, pathTitles)
      }
    }
  }

  walk(null, 1, [])
  return result
}

export function reparentDocument<T extends PageTreeItem>(
  docs: readonly T[],
  documentId: string,
  nextParentId: string | null | undefined
): TreeMutationResult<T> {
  const check = canReparentDocument(docs, documentId, nextParentId)
  if (!check.ok) return check

  const targetParent = normalizedParentId(nextParentId)
  const targetSiblings = docs.filter(
    (doc) => doc.id !== documentId && normalizedParentId(doc.parentId) === targetParent
  )
  const maxOrder = targetSiblings.reduce((max, item, index) => {
    const val = item.order ?? index
    return val > max ? val : max
  }, -1)

  return {
    ok: true,
    docs: docs.map((doc) =>
      doc.id === documentId
        ? { ...doc, parentId: targetParent, order: maxOrder + 1 }
        : doc
    ),
  }
}

export function reorderSiblingDocument<T extends PageTreeItem>(
  docs: readonly T[],
  documentId: string,
  direction: 'up' | 'down'
): TreeMutationResult<T> {
  const target = docs.find((doc) => doc.id === documentId)
  if (!target) return { ok: false, reason: 'document_not_found' }

  const parentId = normalizedParentId(target.parentId)
  const indexById = new Map<string, number>(docs.map((doc, idx) => [doc.id, idx]))
  const siblings = sortSiblings(
    docs.filter((doc) => normalizedParentId(doc.parentId) === parentId),
    indexById
  )
  const currentIndex = siblings.findIndex((doc) => doc.id === documentId)
  if (currentIndex < 0) return { ok: false, reason: 'document_not_found' }

  const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (swapIndex < 0 || swapIndex >= siblings.length) {
    return { ok: true, docs }
  }

  const reordered = [...siblings]
  const a = reordered[currentIndex]
  const b = reordered[swapIndex]
  if (!a || !b) return { ok: true, docs }
  reordered[currentIndex] = b
  reordered[swapIndex] = a

  const nextOrderById = new Map<string, number>(reordered.map((doc, idx) => [doc.id, idx]))
  return {
    ok: true,
    docs: docs.map((doc) => {
      const updatedOrder = nextOrderById.get(doc.id)
      return updatedOrder !== undefined ? { ...doc, order: updatedOrder } : doc
    }),
  }
}

export function deleteLeafDocument<T extends PageTreeItem>(
  docs: readonly T[],
  documentId: string
): TreeMutationResult<T> {
  const check = canDeleteDocument(docs, documentId)
  if (!check.ok) return check
  return {
    ok: true,
    docs: docs.filter((doc) => doc.id !== documentId),
  }
}

export interface DocumentStarterTemplate {
  readonly key: DocumentTemplateKey
  readonly coreTemplateKey: WorkspaceCoreTemplateKey | undefined
  readonly defaultTitle: string
  readonly markdown: string
}

const TEMPLATES_FR: Readonly<Record<DocumentTemplateKey, DocumentStarterTemplate>> = {
  blank: {
    key: 'blank',
    coreTemplateKey: undefined,
    defaultTitle: 'Page sans titre',
    markdown: '## Notes\n\n',
  },
  spec: {
    key: 'spec',
    coreTemplateKey: 'spec',
    defaultTitle: 'Spécification fonctionnelle',
    markdown: [
      '## Contexte',
      '',
      'Décrivez le problème utilisateur et les contraintes connues.',
      '',
      '## Objectifs',
      '',
      '- Premier objectif mesurable',
      '- Deuxième objectif mesurable',
      '',
      '## Périmètre et hors périmètre',
      '',
      '| Élément | Décision |',
      '| --- | --- |',
      '| Parcours principal | Inclus |',
      '| Migration externe | Hors périmètre |',
      '',
      "## Critères d'acceptation",
      '',
      '- [ ] Le parcours nominal est vérifié de bout en bout',
      '- [ ] Les cas de refus affichent une action claire',
      '',
    ].join('\n'),
  },
  adr: {
    key: 'adr',
    coreTemplateKey: 'adr',
    defaultTitle: "Décision d'architecture",
    markdown: [
      '> [!NOTE]',
      '> Statut : Proposé',
      '',
      '## Contexte',
      '',
      'Quelles forces techniques, de sécurité ou de résilience motivent cette décision ?',
      '',
      '## Décision',
      '',
      'Énoncez le choix retenu en termes précis et vérifiables.',
      '',
      '## Conséquences',
      '',
      '- Impacts positifs sur la fiabilité et la maintenance',
      '- Compromis acceptés et garde-fous associés',
      '',
    ].join('\n'),
  },
  meeting_notes: {
    key: 'meeting_notes',
    coreTemplateKey: 'meeting_notes',
    defaultTitle: 'Compte-rendu de réunion',
    markdown: [
      '## Participants',
      '',
      '- Équipe produit et ingénierie',
      '',
      '## Ordre du jour',
      '',
      '1. Point de synchronisation',
      '2. Arbitrages ouverts',
      '',
      '## Décisions retenues',
      '',
      '- ',
      '',
      '## Actions à suivre',
      '',
      '- [ ] Première action assignée',
      '- [ ] Seconde action à confirmer',
      '',
    ].join('\n'),
  },
  runbook: {
    key: 'runbook',
    coreTemplateKey: 'runbook',
    defaultTitle: "Procédure d'exploitation",
    markdown: [
      '> [!NOTE]',
      '> Vérifiez toujours la santé du service avant toute intervention.',
      '',
      '## Symptômes observés',
      '',
      '- Alerte ou comportement dégradé constaté',
      '',
      '## Vérifications préalables',
      '',
      '- [ ] Contrôler les journaux du service concerné',
      '- [ ] Confirmer la fenêtre de maintenance ou prévenir le salon dédié',
      '',
      '## Étapes de remédiation',
      '',
      '1. Isoler le composant en erreur',
      '2. Appliquer le correctif validé',
      '3. Vérifier le retour au nominal',
      '',
      '## Retour arrière',
      '',
      'Décrivez la commande ou manipulation immédiate pour rétablir la version précédente.',
      '',
    ].join('\n'),
  },
}

const TEMPLATES_EN: Readonly<Record<DocumentTemplateKey, DocumentStarterTemplate>> = {
  blank: {
    key: 'blank',
    coreTemplateKey: undefined,
    defaultTitle: 'Untitled page',
    markdown: '## Notes\n\n',
  },
  spec: {
    key: 'spec',
    coreTemplateKey: 'spec',
    defaultTitle: 'Product specification',
    markdown: [
      '## Context',
      '',
      'Describe the user problem and operational constraints.',
      '',
      '## Goals',
      '',
      '- First measurable outcome',
      '- Second measurable outcome',
      '',
      '## Scope and non-goals',
      '',
      '| Item | Decision |',
      '| --- | --- |',
      '| Core workflow | Included |',
      '| Legacy import | Out of scope |',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Primary journey verified end to end',
      '- [ ] Failure states state cause and next action',
      '',
    ].join('\n'),
  },
  adr: {
    key: 'adr',
    coreTemplateKey: 'adr',
    defaultTitle: 'Architecture decision record',
    markdown: [
      '> [!NOTE]',
      '> Status: Proposed',
      '',
      '## Context',
      '',
      'What technical, security, or operational constraints require a decision?',
      '',
      '## Decision',
      '',
      'State the chosen approach clearly and verifiably.',
      '',
      '## Consequences',
      '',
      '- Reliability and maintainability benefits',
      '- Accepted trade-offs and compensating controls',
      '',
    ].join('\n'),
  },
  meeting_notes: {
    key: 'meeting_notes',
    coreTemplateKey: 'meeting_notes',
    defaultTitle: 'Meeting notes',
    markdown: [
      '## Attendees',
      '',
      '- Product and engineering crew',
      '',
      '## Agenda',
      '',
      '1. Status check',
      '2. Open decisions',
      '',
      '## Decisions',
      '',
      '- ',
      '',
      '## Action items',
      '',
      '- [ ] First assigned action',
      '- [ ] Follow-up check',
      '',
    ].join('\n'),
  },
  runbook: {
    key: 'runbook',
    coreTemplateKey: 'runbook',
    defaultTitle: 'Operational runbook',
    markdown: [
      '> [!NOTE]',
      '> Confirm service health indicators before executing recovery steps.',
      '',
      '## Observed symptoms',
      '',
      '- Alert condition or degraded behaviour',
      '',
      '## Pre-flight checks',
      '',
      '- [ ] Inspect service health and recent deployment events',
      '- [ ] Notify the active operations channel',
      '',
      '## Recovery procedure',
      '',
      '1. Isolate the affected component',
      '2. Apply the verified remediation step',
      '3. Confirm metrics return to baseline',
      '',
      '## Rollback',
      '',
      'Document the exact step to restore the previous known-good state.',
      '',
    ].join('\n'),
  },
}

export const CORE_STARTER_TEMPLATE_KEYS: readonly WorkspaceCoreTemplateKey[] = [
  'spec',
  'adr',
  'meeting_notes',
  'runbook',
]

export const ALL_STARTER_TEMPLATE_KEYS: readonly DocumentTemplateKey[] = [
  'blank',
  'spec',
  'adr',
  'meeting_notes',
  'runbook',
]

export function getDocumentStarterTemplate(
  key: DocumentTemplateKey,
  locale: string | undefined
): DocumentStarterTemplate {
  const catalogue = locale?.startsWith('en') ? TEMPLATES_EN : TEMPLATES_FR
  return catalogue[key]
}

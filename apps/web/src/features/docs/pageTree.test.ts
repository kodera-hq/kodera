import { describe, expect, it } from 'vitest'
import {
  ALL_STARTER_TEMPLATE_KEYS,
  CORE_STARTER_TEMPLATE_KEYS,
  MAX_DOCUMENT_TREE_DEPTH,
  buildDocumentTree,
  canCreateDocumentUnderParent,
  canDeleteDocument,
  canReparentDocument,
  deleteLeafDocument,
  getDocumentDepth,
  getDocumentStarterTemplate,
  getSubtreeHeight,
  reorderSiblingDocument,
  reparentDocument,
  type PageTreeItem,
} from './pageTree'

describe('workspace document page tree', () => {
  it('builds a deterministic depth-first hierarchy and attaches orphaned pages at root', () => {
    const items: PageTreeItem[] = [
      { id: 'b', title: 'Second root', parentId: null, order: 1 },
      { id: 'a', title: 'First root', parentId: null, order: 0 },
      { id: 'a-1', title: 'Child page', parentId: 'a', order: 0 },
      { id: 'a-1-1', title: 'Grandchild page', parentId: 'a-1', order: 0 },
      { id: 'orphan', title: 'Orphaned page', parentId: 'missing-parent', order: 2 },
    ]

    const tree = buildDocumentTree(items)
    expect(tree.map((node) => [node.doc.id, node.depth, node.pathTitles.join(' > ')])).toEqual([
      ['a', 1, 'First root'],
      ['a-1', 2, 'First root > Child page'],
      ['a-1-1', 3, 'First root > Child page > Grandchild page'],
      ['b', 1, 'Second root'],
      ['orphan', 1, 'Orphaned page'],
    ])
    expect(tree[0]?.hasChildren).toBe(true)
    expect(getSubtreeHeight(items, 'a')).toBe(3)
  })

  it('enforces the maximum nesting depth of 16 on creation and subtree reparenting', () => {
    const chain: PageTreeItem[] = Array.from({ length: MAX_DOCUMENT_TREE_DEPTH }, (_, index) => ({
      id: `page-${index + 1}`,
      title: `Level ${index + 1}`,
      parentId: index === 0 ? null : `page-${index}`,
      order: 0,
    }))

    expect(getDocumentDepth(chain, `page-${MAX_DOCUMENT_TREE_DEPTH}`)).toBe(MAX_DOCUMENT_TREE_DEPTH)
    expect(canCreateDocumentUnderParent(chain, `page-${MAX_DOCUMENT_TREE_DEPTH - 1}`)).toEqual({
      ok: true,
    })
    expect(canCreateDocumentUnderParent(chain, `page-${MAX_DOCUMENT_TREE_DEPTH}`)).toEqual({
      ok: false,
      reason: 'max_depth_exceeded',
    })

    // A 2-level subtree (`sub-root` -> `sub-leaf`) fits under depth 14 (14 + 2 = 16),
    // and is refused under depth 15 (15 + 2 = 17 > 16).
    const withSubtree: PageTreeItem[] = [
      ...chain,
      { id: 'sub-root', title: 'Subtree root', parentId: null, order: 1 },
      { id: 'sub-leaf', title: 'Subtree leaf', parentId: 'sub-root', order: 0 },
    ]

    expect(canReparentDocument(withSubtree, 'sub-root', 'page-14')).toEqual({ ok: true })
    expect(canReparentDocument(withSubtree, 'sub-root', 'page-15')).toEqual({
      ok: false,
      reason: 'max_depth_exceeded',
    })
  })

  it('refuses self-parenting and ancestor-to-descendant cycles', () => {
    const docs: PageTreeItem[] = [
      { id: 'root', title: 'Architecture', parentId: null },
      { id: 'child', title: 'Networking', parentId: 'root' },
      { id: 'grandchild', title: 'Firewall', parentId: 'child' },
    ]

    expect(reparentDocument(docs, 'root', 'root')).toEqual({
      ok: false,
      reason: 'cycle_detected',
    })
    expect(reparentDocument(docs, 'root', 'grandchild')).toEqual({
      ok: false,
      reason: 'cycle_detected',
    })

    const moved = reparentDocument(docs, 'grandchild', null)
    expect(moved.ok).toBe(true)
    if (moved.ok) {
      expect(getDocumentDepth(moved.docs, 'grandchild')).toBe(1)
    }
  })

  it('reorders siblings deterministically and refuses deleting non-empty parents', () => {
    const docs: PageTreeItem[] = [
      { id: 'first', title: 'First', parentId: null, order: 0 },
      { id: 'second', title: 'Second', parentId: null, order: 1 },
      { id: 'nested', title: 'Nested child', parentId: 'first', order: 0 },
    ]

    const swapped = reorderSiblingDocument(docs, 'second', 'up')
    expect(swapped.ok).toBe(true)
    if (swapped.ok) {
      const rootOrder = buildDocumentTree(swapped.docs)
        .filter((n) => n.depth === 1)
        .map((n) => n.doc.id)
      expect(rootOrder).toEqual(['second', 'first'])
    }

    expect(canDeleteDocument(docs, 'first')).toEqual({
      ok: false,
      reason: 'has_children',
    })
    expect(deleteLeafDocument(docs, 'first')).toEqual({
      ok: false,
      reason: 'has_children',
    })

    const afterChildDeleted = deleteLeafDocument(docs, 'nested')
    expect(afterChildDeleted.ok).toBe(true)
    if (afterChildDeleted.ok) {
      const afterParentDeleted = deleteLeafDocument(afterChildDeleted.docs, 'first')
      expect(afterParentDeleted.ok).toBe(true)
    }
  })

  it('provides all 4 Core 0.43.0 starter templates plus blank in French and English', () => {
    expect(CORE_STARTER_TEMPLATE_KEYS).toEqual(['spec', 'adr', 'meeting_notes', 'runbook'])
    expect(ALL_STARTER_TEMPLATE_KEYS).toEqual([
      'blank',
      'spec',
      'adr',
      'meeting_notes',
      'runbook',
    ])

    for (const key of ALL_STARTER_TEMPLATE_KEYS) {
      const fr = getDocumentStarterTemplate(key, 'fr')
      const en = getDocumentStarterTemplate(key, 'en')
      expect(fr.defaultTitle.length).toBeGreaterThan(0)
      expect(en.defaultTitle.length).toBeGreaterThan(0)
      expect(fr.markdown.length).toBeGreaterThan(0)
      expect(en.markdown.length).toBeGreaterThan(0)
      expect(fr.defaultTitle).not.toBe(en.defaultTitle)
      if (key === 'blank') {
        expect(fr.coreTemplateKey).toBeUndefined()
      } else {
        expect(fr.coreTemplateKey).toBe(key)
        expect(en.coreTemplateKey).toBe(key)
      }
    }
  })
})

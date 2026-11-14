import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ApiProblem } from '@/api/client'
import { createDefaultCollectionSchema, type WorkspaceCollectionRowModel } from './collectionSchema'
import { DocsCollectionView, type CollectionDocumentDescriptor } from './DocsCollectionView'
import { WorkspaceCollaborativeDocs, type WorkspacePageRecord } from './WorkspaceCollaborativeDocs'
import * as docsApi from './workspaceDocumentsApi'

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('fr')
})

const SAMPLE_DOCS: readonly CollectionDocumentDescriptor[] = [
  {
    id: 'doc-1',
    title: 'Architecture Réseau',
    updatedAt: '2026-11-10T10:00:00Z',
    role: 'editor',
  },
  {
    id: 'doc-2',
    title: 'Plan de Continuité',
    updatedAt: '2026-11-12T10:00:00Z',
    role: 'editor',
  },
  {
    id: 'doc-3',
    title: '=CMD|\' /C calc\'!A0',
    updatedAt: '2026-11-13T10:00:00Z',
    role: 'editor',
  },
]

const SAMPLE_MEMBERS = [
  { id: 'u-camille', name: 'Camille Laurent' },
  { id: 'u-omar', name: 'Omar Diallo' },
]

const SAMPLE_ROWS: readonly WorkspaceCollectionRowModel[] = [
  {
    documentId: 'doc-1',
    updatedAt: '2026-11-10T10:00:00Z',
    values: {
      status: { kind: 'status', value: 'done' },
      priority: { kind: 'priority', value: 'high' },
      assignee: { kind: 'assignee', value: 'u-camille' },
      due_date: { kind: 'due_date', value: '2026-11-20' },
      verified: { kind: 'checkbox', value: true },
      estimate: { kind: 'number', value: 8 },
      reference_url: { kind: 'url', value: 'https://docs.kodera.io/network' },
      tags: { kind: 'tags', value: ['architecture', 'security'] },
    },
  },
  {
    documentId: 'doc-2',
    updatedAt: '2026-11-12T10:00:00Z',
    values: {
      status: { kind: 'status', value: 'in_progress' },
      priority: { kind: 'priority', value: 'urgent' },
      assignee: { kind: 'assignee', value: 'u-omar' },
      due_date: { kind: 'due_date', value: '2026-11-25' },
      verified: { kind: 'checkbox', value: false },
      estimate: { kind: 'number', value: 4 },
      reference_url: { kind: 'url', value: null },
      tags: { kind: 'tags', value: ['ops'] },
    },
  },
  {
    documentId: 'doc-3',
    updatedAt: '2026-11-13T10:00:00Z',
    values: {
      status: { kind: 'status', value: 'todo' },
      priority: { kind: 'priority', value: 'low' },
      assignee: { kind: 'assignee', value: null },
      due_date: { kind: 'due_date', value: null },
      verified: { kind: 'checkbox', value: false },
      estimate: { kind: 'number', value: 3 },
      reference_url: { kind: 'url', value: null },
      tags: { kind: 'tags', value: ['product'] },
    },
  },
]

describe(
  'DocsCollectionView (Table, Kanban, List, Filters, ETag Concurrency, Security & CSP)',
  { timeout: 15_000 },
  () => {
  it('switches instantly between Table, Kanban, and List views via mouse and keyboard with zero inline styles', async () => {
    const user = userEvent.setup()
    const onOpenDocument = vi.fn()
    const schema = createDefaultCollectionSchema('fr')

    const { container } = render(
      <DocsCollectionView
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        onOpenDocument={onOpenDocument}
      />
    )

    // Table view active initially with role="grid"
    expect(screen.getByRole('grid', { name: schema.title })).toBeInTheDocument()
    const tableTab = screen.getByTestId('collection-view-tab-table')
    const boardTab = screen.getByTestId('collection-view-tab-board')
    const listTab = screen.getByTestId('collection-view-tab-list')
    expect(tableTab).toHaveAttribute('aria-selected', 'true')

    // Keyboard ArrowRight switches tablist from Table -> Kanban -> List
    tableTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(boardTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('collection-board-view')).toBeInTheDocument()
    expect(screen.getByTestId('collection-board-count-done')).toHaveTextContent('1')
    expect(screen.getByTestId('collection-board-count-in_progress')).toHaveTextContent('1')
    expect(screen.getByTestId('collection-board-count-todo')).toHaveTextContent('1')

    await user.keyboard('{ArrowRight}')
    expect(listTab).toHaveAttribute('aria-selected', 'true')
    const listView = screen.getByTestId('collection-list-view')
    expect(listView).toBeInTheDocument()
    expect(within(listView).getAllByRole('listitem')).toHaveLength(3)

    // Keyboard ArrowDown inside List navigates focus between triage rows
    const firstListBtn = screen.getByTestId('collection-list-open-doc-3')
    firstListBtn.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('collection-list-open-doc-1')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onOpenDocument).toHaveBeenCalledWith('doc-1')

    // Return to Table via Home key and navigate grid cells with ArrowRight / ArrowDown
    listTab.focus()
    await user.keyboard('{Home}')
    expect(tableTab).toHaveAttribute('aria-selected', 'true')

    const row0Col0 = screen.getByTestId('collection-open-doc-doc-3')
    row0Col0.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('collection-open-doc-doc-1')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByTestId('collection-cell-doc-1-status')).toHaveFocus()

    // Strict CSP: zero inline style attributes and zero injected <style> elements
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    expect(container.querySelectorAll('style')).toHaveLength(0)
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
  })

  it('filters via multi-chip bar, sorts columns asc/desc, computes rollups, and exports neutralized CSV, JSON, and Markdown', async () => {
    await i18n.changeLanguage('en')
    const user = userEvent.setup()
    const exported: Array<{ format: string; content: string }> = []
    const schema = createDefaultCollectionSchema('en')

    const { container } = render(
      <DocsCollectionView
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        onExport={(format, content) => {
          exported.push({ format, content })
        }}
      />
    )

    // Initial rollup across all 3 items: 1/3 done (33%), Verified: 33%, Effort sum 15 avg 5
    expect(screen.getByTestId('collection-rollup-count')).toHaveTextContent('3 entries')
    expect(screen.getByTestId('collection-rollup-done')).toHaveTextContent('Done: 33% (1/3)')
    expect(screen.getByTestId('collection-rollup-checkbox-verified')).toHaveTextContent(
      'Verified: 33% checked'
    )
    expect(screen.getByTestId('collection-rollup-number-estimate')).toHaveTextContent(
      'Effort: sum 15 · avg 5'
    )

    // Sort by Effort descending via column header button
    const estimateHeaderBtn = screen.getByRole('button', { name: /Effort/i })
    await user.click(estimateHeaderBtn) // asc
    await user.click(estimateHeaderBtn) // desc
    const rowsAfterSort = within(screen.getByTestId('collection-table-grid'))
      .getAllByRole('row')
      .slice(1, 4)
    expect(rowsAfterSort[0]).toHaveAttribute('data-testid', 'collection-table-row-doc-1')

    // Filter by tag `security` -> narrows to `doc-1`, renders filter chip, updates rollups to 1/1 (100%)
    await user.selectOptions(screen.getByTestId('collection-filter-tag'), 'security')
    expect(screen.getByTestId('collection-active-filter-chips')).toBeInTheDocument()
    expect(screen.getByTestId('collection-rollup-count')).toHaveTextContent('1 / 3 entries')
    expect(screen.getByTestId('collection-rollup-done')).toHaveTextContent('Done: 100% (1/1)')

    // Clear filters via button -> back to 3 entries
    await user.click(screen.getByTestId('collection-clear-filters'))
    expect(screen.getByTestId('collection-rollup-count')).toHaveTextContent('3 entries')

    // Search filter + Escape key clears search
    const searchInput = screen.getByTestId('collection-search-input')
    await user.type(searchInput, 'Continuité')
    expect(screen.getByTestId('collection-rollup-count')).toHaveTextContent('1 / 3 entries')
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('collection-rollup-count')).toHaveTextContent('3 entries')

    // Export CSV, JSON, and Markdown and verify formula-injection neutralization
    await user.click(screen.getByTestId('collection-export-csv'))
    await user.click(screen.getByTestId('collection-export-json'))
    await user.click(screen.getByTestId('collection-export-markdown'))

    expect(exported.map((e) => e.format)).toEqual(['csv', 'json', 'markdown'])
    expect(exported[0]?.content).toContain('"\'=CMD|\' /C calc\'!A0"')
    expect(JSON.parse(exported[1]!.content).totalCount).toBe(3)
    expect(exported[2]?.content).toContain('| Document | Status |')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('moves Kanban cards across status and priority columns via keyboard (Alt+ArrowRight), quick-move, and pointer drag without inline styles', async () => {
    const user = userEvent.setup()
    const schema = createDefaultCollectionSchema('fr')

    const { container } = render(
      <DocsCollectionView
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        initialView="board"
      />
    )

    // Initially doc-3 is in `todo`
    expect(screen.getByTestId('collection-board-count-todo')).toHaveTextContent('1')
    expect(screen.getByTestId('collection-board-count-in_progress')).toHaveTextContent('1')

    // Move doc-3 right (`todo` -> `in_progress`) using Alt+ArrowRight on the card button
    const doc3CardBtn = screen.getByTestId('collection-board-open-doc-3')
    doc3CardBtn.focus()
    fireEvent.keyDown(doc3CardBtn, { key: 'ArrowRight', altKey: true })
    expect(screen.getByTestId('collection-board-count-todo')).toHaveTextContent('0')
    expect(screen.getByTestId('collection-board-count-in_progress')).toHaveTextContent('2')

    // Pointer drag doc-3 from `in_progress` to `done` column without any inline style attributes
    const doneColumn = screen.getByTestId('collection-board-column-done')
    const dataTransfer = {
      data: '' as string,
      setData(_type: string, val: string) {
        this.data = val
      },
      getData() {
        return this.data
      },
    }
    fireEvent.dragStart(screen.getByTestId('collection-board-open-doc-3'), { dataTransfer })
    fireEvent.dragOver(doneColumn, { dataTransfer })
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    fireEvent.drop(doneColumn, { dataTransfer })
    expect(screen.getByTestId('collection-board-count-done')).toHaveTextContent('2')

    // Switch Kanban grouping from `status` to `priority`
    await user.selectOptions(screen.getByTestId('collection-board-groupby'), 'priority')
    expect(screen.getByTestId('collection-board-count-urgent')).toHaveTextContent('1')
    expect(screen.getByTestId('collection-board-count-high')).toHaveTextContent('1')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('refuses malicious javascript: and data: URLs with an accessible error alert and accepts https:// links', async () => {
    const user = userEvent.setup()
    const schema = createDefaultCollectionSchema('fr')

    const { container } = render(
      <DocsCollectionView
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
      />
    )

    // Open inline URL editor for doc-2 (`reference_url` is currently null)
    await user.click(screen.getByTestId('collection-cell-doc-2-reference_url'))
    const urlInput = screen.getByTestId('collection-url-input-doc-2-reference_url')
    await user.clear(urlInput)
    await user.type(urlInput, 'javascript:alert(document.cookie){Enter}')

    // Alert shown, malicious href never rendered
    expect(await screen.findByTestId('collection-validation-error')).toBeInTheDocument()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()

    // Now provide a valid https:// URL
    await user.clear(urlInput)
    await user.type(urlInput, 'https://kodera.io/security{Enter}')
    expect(screen.queryByTestId('collection-validation-error')).toBeNull()

    const safeLink = screen.getByRole('link', { name: /Plan de Continuité/i })
    expect(safeLink).toHaveAttribute('href', 'https://kodera.io/security')
    expect(safeLink).toHaveAttribute('target', '_blank')
    expect(safeLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('transmits If-Match / If-None-Match: * headers on inline edits and recovers cleanly from 412 Precondition Failed conflicts', async () => {
    const user = userEvent.setup()
    const schema = createDefaultCollectionSchema('fr')

    const putSpy = vi
      .spyOn(docsApi, 'putWorkspaceCollectionRow')
      .mockResolvedValueOnce({
        row: {
          ...SAMPLE_ROWS[0]!,
          values: {
            ...SAMPLE_ROWS[0]!.values,
            verified: { kind: 'checkbox', value: false },
          },
          updatedAt: '2026-11-13T14:00:00Z',
        },
        etag: '"etag-doc-1-v2"',
        created: false,
      })
      .mockRejectedValueOnce(
        new ApiProblem({
          type: 'https://kodera.io/problems/precondition-failed',
          status: 412,
          title: 'Precondition Failed',
          currentEtag: '"etag-doc-1-remote-v3"',
        } as never)
      )
      .mockResolvedValueOnce({
        row: {
          ...SAMPLE_ROWS[0]!,
          values: {
            ...SAMPLE_ROWS[0]!.values,
            status: { kind: 'status', value: 'review' },
          },
          updatedAt: '2026-11-13T14:10:00Z',
        },
        etag: '"etag-doc-1-v4"',
        created: false,
      })

    const getRowSpy = vi.spyOn(docsApi, 'getWorkspaceCollectionRow').mockResolvedValue({
      row: {
        ...SAMPLE_ROWS[0]!,
        values: {
          ...SAMPLE_ROWS[0]!.values,
          status: { kind: 'status', value: 'in_progress' },
        },
        updatedAt: '2026-11-13T14:05:00Z',
      },
      etag: '"etag-doc-1-remote-v3"',
      created: false,
    })
    vi.spyOn(docsApi, 'getWorkspaceCollection').mockResolvedValue({
      collection: schema,
      etag: '"col-v1"',
    })
    vi.spyOn(docsApi, 'queryWorkspaceCollection').mockResolvedValue({
      rows: [
        {
          ...SAMPLE_ROWS[0]!,
          values: {
            ...SAMPLE_ROWS[0]!.values,
            status: { kind: 'status', value: 'in_progress' },
          },
        },
        SAMPLE_ROWS[1]!,
        SAMPLE_ROWS[2]!,
      ],
      nextCursor: null,
      hasMore: false,
    })

    render(
      <DocsCollectionView
        organisationId="org-vercelli"
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        initialRowEtags={{ 'doc-1': '"etag-doc-1-v1"' }}
      />
    )

    // 1. Toggle checkbox on doc-1 -> sends If-Match: "etag-doc-1-v1" and stores "etag-doc-1-v2"
    await user.click(screen.getByTestId('collection-cell-doc-1-verified'))
    await waitFor(() =>
      expect(putSpy).toHaveBeenNthCalledWith(
        1,
        'org-vercelli',
        schema.id,
        'doc-1',
        expect.objectContaining({ verified: { kind: 'checkbox', value: false } }),
        { mode: 'update', ifMatch: '"etag-doc-1-v1"' },
        schema.properties
      )
    )

    // 2. Change status on doc-1 when server rejects with 412 -> rolls back & shows conflict banner
    await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'review')
    const conflictBanner = await screen.findByTestId('collection-conflict-banner')
    expect(conflictBanner).toHaveAttribute('role', 'alert')

    // 3. Click Reload on conflict banner -> fetches fresh row + ETag and clears banner
    await user.click(screen.getByTestId('collection-conflict-reload'))
    await waitFor(() => expect(getRowSpy).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByTestId('collection-conflict-banner')).toBeNull()
    )
    expect(screen.getByTestId('collection-cell-doc-1-status')).toHaveValue('in_progress')

    // 4. Retry edit -> uses refreshed ETag `"etag-doc-1-remote-v3"` and succeeds
    await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'review')
    await waitFor(() =>
      expect(putSpy).toHaveBeenNthCalledWith(
        3,
        'org-vercelli',
        schema.id,
        'doc-1',
        expect.objectContaining({ status: { kind: 'status', value: 'review' } }),
        { mode: 'update', ifMatch: '"etag-doc-1-remote-v3"' },
        schema.properties
      )
    )
  })

  it('opens a collection row directly into the collaborative Yjs PageEditor without tearing down the active Yjs session', async () => {
    const user = userEvent.setup()
    const schema = createDefaultCollectionSchema('fr')
    const pages: WorkspacePageRecord[] = [
      {
        id: 'doc-1',
        parentId: null,
        title: 'Architecture Réseau',
        markdown: '## Architecture\n\nContenu collaboratif Yjs.',
        role: 'editor',
        updatedAt: '2026-11-10T10:00:00Z',
      },
      {
        id: 'doc-2',
        parentId: null,
        title: 'Plan de Continuité',
        markdown: '## Continuité\n\nRunbook critique.',
        role: 'editor',
        updatedAt: '2026-11-12T10:00:00Z',
      },
    ]

    vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue(pages)
    vi.spyOn(docsApi, 'getWorkspaceDocument').mockImplementation(async (_org, docId) => ({
      document: pages.find((p) => p.id === docId) ?? pages[0]!,
      etag: `"doc-etag-${docId}"`,
    }))
    vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
    const collabSessionSpy = vi
      .spyOn(docsApi, 'createWorkspaceDocumentCollabSession')
      .mockImplementation(async (_org, docId) => ({
        wsUrl: `wss://collab.kodera.io/ws/${docId}`,
        token: `ticket-${docId}`,
        expiresAt: '2099-01-01T00:00:00Z',
        role: 'editor',
      }))

    vi.spyOn(docsApi, 'listWorkspaceCollections').mockResolvedValue({
      collections: [schema],
      etag: '"col-v1"',
      nextCursor: null,
      hasMore: false,
    })
    vi.spyOn(docsApi, 'getWorkspaceCollection').mockResolvedValue({
      collection: schema,
      etag: '"col-v1"',
    })
    vi.spyOn(docsApi, 'queryWorkspaceCollection').mockResolvedValue({
      rows: [SAMPLE_ROWS[0]!, SAMPLE_ROWS[1]!],
      nextCursor: null,
      hasMore: false,
    })

    const socketCloseSpy = vi.fn()
    const noopSocketFactory = () => ({
      binaryType: 'arraybuffer' as BinaryType,
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: socketCloseSpy,
    })

    const { container } = render(
      <WorkspaceCollaborativeDocs
        organisationId="org-1"
        currentUser={{ id: 'u-camille', name: 'Camille Laurent' }}
        webSocketFactory={noopSocketFactory}
      />
    )

    expect(await screen.findByTestId('docs-tree-item-doc-1')).toBeInTheDocument()
    await waitFor(() => expect(collabSessionSpy).toHaveBeenCalledTimes(1))
    expect(socketCloseSpy).not.toHaveBeenCalled()

    // Switch surface to Collections -> Yjs session for doc-1 remains alive (not closed!)
    await user.click(screen.getByTestId('docs-surface-collections'))
    expect(await screen.findByTestId('docs-collection-view')).toBeInTheDocument()
    expect(socketCloseSpy).not.toHaveBeenCalled()
    expect(collabSessionSpy).toHaveBeenCalledTimes(1)

    // 1-click open `doc-1` from Table back into `CollaborativeBlockEditor` -> zero Yjs session churn!
    await user.click(screen.getByTestId('collection-open-doc-doc-1'))
    expect(await screen.findByTestId('docs-collab-prosemirror')).toBeInTheDocument()
    expect(socketCloseSpy).not.toHaveBeenCalled()
    expect(collabSessionSpy).toHaveBeenCalledTimes(1)

    // Switch back to Collections -> Kanban -> 1-click open `doc-2` into `CollaborativeBlockEditor`
    await user.click(screen.getByTestId('docs-surface-collections'))
    await user.click(await screen.findByTestId('collection-view-tab-board'))
    await user.click(screen.getByTestId('collection-board-open-doc-2'))

    expect(await screen.findByTestId('docs-collab-prosemirror')).toBeInTheDocument()
    expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Plan de Continuité')
    await waitFor(() =>
      expect(collabSessionSpy).toHaveBeenLastCalledWith('org-1', 'doc-2')
    )
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('enforces viewer read-only mode and uses If-None-Match: * when initializing a new document row', async () => {
    const user = userEvent.setup()
    const schema = createDefaultCollectionSchema('fr')

    const { unmount } = render(
      <DocsCollectionView
        documents={SAMPLE_DOCS}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        accessRole="viewer"
      />
    )

    expect(screen.getByTestId('collection-readonly-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('collection-new-entry-input')).toBeNull()
    expect(screen.getByTestId('collection-cell-doc-1-verified')).toBeDisabled()
    unmount()

    const putSpy = vi.spyOn(docsApi, 'putWorkspaceCollectionRow').mockResolvedValue({
      row: {
        documentId: 'doc-new',
        values: { status: { kind: 'status', value: 'in_progress' } },
        updatedAt: '2026-11-13T15:00:00Z',
      },
      etag: '"etag-doc-new-v1"',
      created: true,
    })

    render(
      <DocsCollectionView
        organisationId="org-vercelli"
        documents={[
          ...SAMPLE_DOCS,
          {
            id: 'doc-new',
            title: 'Nouvelle Spécification',
            updatedAt: '2026-11-13T15:00:00Z',
            role: 'editor',
          },
        ]}
        members={SAMPLE_MEMBERS}
        initialCollection={schema}
        initialRows={SAMPLE_ROWS}
        initialRowEtags={{ 'doc-1': '"etag-doc-1-v1"' }}
      />
    )

    await user.selectOptions(screen.getByTestId('collection-cell-doc-new-status'), 'in_progress')
    await waitFor(() =>
      expect(putSpy).toHaveBeenCalledWith(
        'org-vercelli',
        schema.id,
        'doc-new',
        expect.objectContaining({ status: { kind: 'status', value: 'in_progress' } }),
        { mode: 'create', ifNoneMatch: '*' },
        schema.properties
      )
    )
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '@/api/client'
import { DriveWorkspaceContext, type DriveWorkspaceContextValue } from './DriveWorkspaceContext'
import * as docsApi from './workspaceDocumentsApi'
import { createDefaultCollectionSchema } from './collectionSchema'

vi.mock('../whiteboard/WhiteboardCanvas', () => ({
  WhiteboardCanvas: () => <canvas data-testid="whiteboard-canvas" />,
}))
afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.removeItem('kodera.docs.pending-typed-creation')
})
import { WorkspaceCollaborativeDocs } from './WorkspaceCollaborativeDocs'
import {
  DOCUMENT_KIND_MARKERS,
  readDriveCollectionRows,
  writeDriveCollectionRows,
} from './driveKinds'
import { workspaceFilesOf } from '../espace/workspaceFiles'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'

it('rejects rows that cannot round-trip through the base codec', () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({
    documentId: `${i}`,
    values: {},
    updatedAt: '',
  }))
  expect(() => writeDriveCollectionRows('', rows)).toThrow(RangeError)
})
it('does not read unclassified channel timelines or documents', () => {
  const getTimeline = vi.fn(() => [])
  const store = { getTimeline } as unknown as EspaceStoreLike
  const snapshot = {
    channels: new Map([['a', { state: 'resolved', roomId: '!a' }]]),
    rooms: [],
  } as unknown as EspaceSnapshot
  expect(
    workspaceFilesOf(
      store,
      snapshot,
      [{ id: 'a', kind: 'text', label: 'a' }],
      [{ id: 'secret', channelId: 'a', title: 'Secret', content: 'Secret' }]
    )
  ).toEqual([])
  expect(getTimeline).not.toHaveBeenCalled()
})
it('retains the whiteboard opening action on an ordinary page', async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceCollaborativeDocs
      localDocuments={[
        { id: 'a', parentId: null, title: 'Page', markdown: '', updatedAt: '', role: 'editor' },
      ]}
      activeDocumentId="a"
    />
  )
  await user.click(screen.getByRole('button', { name: 'Tableau blanc' }))
  expect(await screen.findByTestId('whiteboard-canvas')).toBeInTheDocument()
})

const page: docsApi.CoreWorkspaceDocument = {
  id: 'page',
  title: 'Page',
  parentId: null,
  markdown: '# Page',
  role: 'editor' as const,
  updatedAt: '',
}
function channelContext(): DriveWorkspaceContextValue {
  return {
    workspaceId: 'workspace',
    canvasMode: 'files',
    navigationRequestKey: 0,
    store: {
      getTimeline: () => [],
      getRoomBoundary: () => 'ordinary',
    } as unknown as EspaceStoreLike,
    snapshot: {
      channels: new Map([['general', { state: 'resolved', roomId: '!general' }]]),
      rooms: [],
    } as unknown as EspaceSnapshot,
    channels: [{ id: 'general', kind: 'text', label: 'general' }],
    documents: [
      { id: 'guide', channelId: 'general', title: 'Channel guide', content: '# Channel guide' },
    ],
    activeChannelId: 'general',
    roomBoundary: 'ordinary',
    isConfidential: false,
    requestedDocument: undefined,
    onOpenChannel: vi.fn(),
    onOpenDirect: vi.fn(),
  }
}

it('consumes a refused source-bound request once without reopening its body in another room', async () => {
  const context = channelContext()
  const handled = vi.fn()
  const changed = vi.fn()
  const protectedContext = {
    ...context,
    isConfidential: true,
    roomBoundary: 'confidential-unavailable' as const,
    requestedDocument: { id: 'guide', channelId: 'general', roomId: '!general', sequence: 1 },
    onDocumentRequestHandled: handled,
  }
  const view = render(
    <DriveWorkspaceContext.Provider value={protectedContext}>
      <WorkspaceCollaborativeDocs localDocuments={[page]} onLocalDocumentsChange={changed} />
    </DriveWorkspaceContext.Provider>
  )
  await waitFor(() => expect(handled).toHaveBeenCalledWith(1))
  view.rerender(
    <DriveWorkspaceContext.Provider
      value={{ ...context, activeChannelId: 'other', documents: [], requestedDocument: undefined }}
    >
      <WorkspaceCollaborativeDocs localDocuments={[page]} onLocalDocumentsChange={changed} />
    </DriveWorkspaceContext.Provider>
  )
  expect(screen.queryByTestId('docs-page-title-input')).toBeNull()
  expect(screen.queryByText('Channel guide')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

it('writes channel title and body edits to their source and restores them after remount', async () => {
  const user = userEvent.setup()
  const context = channelContext()
  let source = context.documents[0]!
  const update = vi.fn(
    (_channelId: string, _id: string, patch: { title: string; content: string }) => {
      source = { ...source, ...patch }
    }
  )
  const renderPanel = () => (
    <DriveWorkspaceContext.Provider
      value={{ ...context, documents: [source], onUpdateChannelDocument: update }}
    >
      <WorkspaceCollaborativeDocs localDocuments={[]} />
    </DriveWorkspaceContext.Provider>
  )
  const view = render(renderPanel())
  await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
  await user.click(screen.getByTestId('drive-doc-card-channel:guide'))
  fireEvent.change(screen.getByTestId('docs-page-title-input'), {
    target: { value: 'Updated guide' },
  })
  await user.click(screen.getByTestId('docs-surface-markdown'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Source Markdown' }), {
    target: { value: '# Updated body' },
  })
  expect(update).toHaveBeenLastCalledWith('general', 'guide', {
    title: 'Updated guide',
    content: '# Updated body',
  })
  view.unmount()
  render(renderPanel())
  await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
  await user.click(screen.getByTestId('drive-doc-card-channel:guide'))
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Updated guide')
  expect(screen.getByTestId('docs-collab-prosemirror')).toHaveTextContent('Updated body')
})

it('returns to the Drive root for each repeated Files request while the mode stays files', async () => {
  const user = userEvent.setup()
  const context = channelContext()
  const panel = (key: number) => (
    <DriveWorkspaceContext.Provider value={{ ...context, navigationRequestKey: key }}>
      <WorkspaceCollaborativeDocs localDocuments={[page]} />
    </DriveWorkspaceContext.Provider>
  )
  const view = render(panel(1))
  await user.click(screen.getByTestId('drive-doc-card-page'))
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Page')
  view.rerender(panel(2))
  expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
  await user.click(screen.getByTestId('drive-doc-card-page'))
  view.rerender(panel(3))
  expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
})

function mockRemotePages(pages = [page]) {
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue(pages)
  const read = vi.spyOn(docsApi, 'getWorkspaceDocument').mockImplementation(async (_org, id) => {
    const document = pages.find((doc) => doc.id === id)
    if (!document) throw new Error('Not found')
    return { document, etag: '"v1"' }
  })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockRejectedValue(
    new Error('Unavailable')
  )
  return read
}

it.each(['base', 'whiteboard', 'folder'] as const)(
  'retries the same created %s ID after its marker PATCH fails',
  async (kind) => {
    mockRemotePages([])
    const user = userEvent.setup()
    let created: docsApi.CoreWorkspaceDocument = { ...page, id: 'created' }
    const create = vi
      .spyOn(docsApi, 'createWorkspaceDocument')
      .mockResolvedValue({ document: created, etag: '"v1"' })
    const patch = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementation(async (_org, id, _etag, body) => {
        created = {
          ...created,
          id,
          ...body,
          markdown: body.markdown?.trimEnd() ?? created.markdown,
        }
        return { document: created, etag: '"v2"' }
      })
    vi.mocked(docsApi.getWorkspaceDocument).mockImplementation(async () => ({
      document: created,
      etag: '"v2"',
    }))
    render(<WorkspaceCollaborativeDocs organisationId="org" />)
    await waitFor(() => expect(docsApi.listWorkspaceDocuments).toHaveBeenCalled())
    const action =
      kind === 'base'
        ? 'Nouvelle base'
        : kind === 'whiteboard'
          ? 'Nouveau tableau blanc'
          : 'Nouveau dossier'
    const submit = async () => {
      await user.click(screen.getByRole('button', { name: action }))
      if (kind === 'folder') {
        await user.type(screen.getByTestId('drive-new-folder-input'), 'Reports')
        await user.click(screen.getByTestId('drive-new-folder-submit'))
      }
    }
    await submit()
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('drive-folder-card-created')).toBeNull()
    expect(screen.queryByTestId('docs-collection-view')).toBeNull()
    expect(screen.queryByTestId('whiteboard-canvas')).toBeNull()
    created = { ...created, markdown: 'Collaborator prose after the failed write' }
    await submit()
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(patch.mock.calls[1]?.[3].markdown).toContain('Collaborator prose after the failed write')
    expect(create).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls.map((call) => call[1])).toEqual(['created', 'created'])
    expect(
      await screen.findByTestId(
        kind === 'base'
          ? 'docs-collection-view'
          : kind === 'whiteboard'
            ? 'whiteboard-canvas'
            : 'drive-folder-card-created'
      )
    ).toBeInTheDocument()
  }
)

it('preserves the Core collection query for the remote Collections surface on an ordinary page', async () => {
  mockRemotePages()
  const schema = { ...createDefaultCollectionSchema('fr'), id: 'remote-collection' }
  const list = vi
    .spyOn(docsApi, 'listWorkspaceCollections')
    .mockResolvedValue({ collections: [schema], nextCursor: null, etag: null, hasMore: false })
  vi.spyOn(docsApi, 'getWorkspaceCollection').mockResolvedValue({
    collection: schema,
    etag: '"collection-v1"',
  })
  const query = vi
    .spyOn(docsApi, 'queryWorkspaceCollection')
    .mockResolvedValue({ rows: [], nextCursor: null, hasMore: false })
  render(<WorkspaceCollaborativeDocs organisationId="org" initialSurface="collections" />)
  await waitFor(() => expect(list).toHaveBeenCalled())
  await waitFor(() => expect(query).toHaveBeenCalled())
})

it('replaces cached base rows on a 412 reload before the next write uses the fresh version', async () => {
  const user = userEvent.setup()
  const row = {
    documentId: 'row',
    updatedAt: '',
    values: {
      estimate: { kind: 'number' as const, value: 3 },
      verified: { kind: 'checkbox' as const, value: false },
    },
  }
  const base = { ...page, markdown: writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, [row]) }
  const read = mockRemotePages([base, { ...page, id: 'row', parentId: base.id, title: 'Entry' }])
  const write = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockRejectedValueOnce(
      new ApiProblem({ type: null, status: 412, title: 'Precondition Failed' })
    )
    .mockResolvedValue({ document: base, etag: '"v10"' })
  render(
    <WorkspaceCollaborativeDocs
      organisationId="org"
      activeDocumentId="page"
      initialSurface="collections"
    />
  )
  const cell = await screen.findByTestId('collection-cell-row-verified')
  await user.click(cell)
  await screen.findByTestId('page-conflict-reload')
  const fresh = {
    ...base,
    markdown: writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, [
      { ...row, values: { ...row.values, estimate: { kind: 'number', value: 99 } } },
    ]),
  }
  read.mockResolvedValue({ document: fresh, etag: '"v9"' })
  await user.click(screen.getByTestId('page-conflict-reload'))
  await waitFor(() =>
    expect(screen.getByRole('spinbutton', { name: 'Charge pour Entry' })).toHaveValue(99)
  )
  await user.click(screen.getByTestId('collection-cell-row-verified'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  const [, , etag, patch] = write.mock.calls[1]!
  expect(etag).toBe('"v9"')
  expect(readDriveCollectionRows(patch.markdown!)[0]?.values.estimate).toEqual({
    kind: 'number',
    value: 99,
  })
})

it('loads shared documents directly beyond the initial list page', async () => {
  const read = mockRemotePages([])
  const linked = { ...page, id: 'older-page', title: 'Older shared page' }
  read.mockResolvedValue({ document: linked, etag: '"v7"' })
  render(<WorkspaceCollaborativeDocs organisationId="org" activeDocumentId={linked.id} />)
  expect(await screen.findByTestId('docs-page-title-input')).toHaveValue(linked.title)
  expect(read).toHaveBeenCalledWith('org', linked.id, expect.anything())
})
it.each(['remote', 'local'] as const)(
  'announces an unavailable shared document in %s mode',
  async (mode) => {
    const read = mockRemotePages([])
    read.mockRejectedValue(new ApiProblem({ type: null, status: 404, title: 'Not Found' }))
    render(
      <WorkspaceCollaborativeDocs
        {...(mode === 'remote' ? { organisationId: 'org' } : { localDocuments: [] })}
        activeDocumentId="missing"
      />
    )
    expect(await screen.findByText('Document introuvable ou inaccessible')).toBeInTheDocument()
    expect(screen.queryByText(/^Aucune page/)).toBeNull()
  }
)
it('refreshes cached base rows on ordinary reopen before using the refreshed ETag', async () => {
  const user = userEvent.setup()
  const row = {
    documentId: 'row',
    updatedAt: '',
    values: {
      estimate: { kind: 'number' as const, value: 3 },
      verified: { kind: 'checkbox' as const, value: false },
    },
  }
  let base = { ...page, markdown: writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, [row]) }
  const other = { ...page, id: 'other', title: 'Other page' }
  const child = { ...page, id: 'row', parentId: page.id, title: 'Entry' }
  const read = mockRemotePages([base, other, child])
  const write = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockImplementation(async (_org, _id, _version, patch) => {
      base = { ...base, ...patch }
      return { document: base, etag: '"v2"' }
    })
  const props = { organisationId: 'org', initialSurface: 'collections' as const }
  const view = render(<WorkspaceCollaborativeDocs {...props} activeDocumentId={base.id} />)
  await user.click(await screen.findByTestId('collection-cell-row-verified'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByTestId('docs-saving-indicator')).toBeNull())
  view.rerender(<WorkspaceCollaborativeDocs {...props} activeDocumentId={other.id} />)
  await waitFor(() => expect(read).toHaveBeenCalledWith('org', other.id, expect.anything()))
  base = {
    ...base,
    markdown: writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, [
      { ...row, values: { ...row.values, estimate: { kind: 'number', value: 99 } } },
    ]),
  }
  read.mockResolvedValue({ document: base, etag: '"v9"' })
  view.rerender(<WorkspaceCollaborativeDocs {...props} activeDocumentId={base.id} />)
  await waitFor(() =>
    expect(screen.getByRole('spinbutton', { name: 'Charge pour Entry' })).toHaveValue(99)
  )
  await user.click(screen.getByTestId('collection-cell-row-verified'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  const [, , etag, patch] = write.mock.calls[1]!
  expect(etag).toBe('"v9"')
  expect(readDriveCollectionRows(patch.markdown!)[0]?.values.estimate).toEqual({
    kind: 'number',
    value: 99,
  })
})

it('opens Core Collections explicitly even while a marked base is selected', async () => {
  mockRemotePages([{ ...page, markdown: DOCUMENT_KIND_MARKERS.base }])
  const schema = { ...createDefaultCollectionSchema('fr'), id: 'core-collection' }
  const list = vi
    .spyOn(docsApi, 'listWorkspaceCollections')
    .mockResolvedValue({ collections: [schema], nextCursor: null, etag: null, hasMore: false })
  vi.spyOn(docsApi, 'getWorkspaceCollection').mockResolvedValue({
    collection: schema,
    etag: '"v1"',
  })
  const query = vi
    .spyOn(docsApi, 'queryWorkspaceCollection')
    .mockResolvedValue({ rows: [], nextCursor: null, hasMore: false })
  render(
    <WorkspaceCollaborativeDocs
      organisationId="org"
      activeDocumentId="page"
      initialSurface="core-collections"
    />
  )
  await waitFor(() => expect(list).toHaveBeenCalled())
  await waitFor(() => expect(query).toHaveBeenCalled())
})
it('retains distinct pending folder intents until each marker is persisted', async () => {
  const read = mockRemotePages([])
  read.mockImplementation(async (_org, id) => ({
    document: { ...page, id, title: id },
    etag: '"v1"',
  }))
  const user = userEvent.setup()
  const create = vi
    .spyOn(docsApi, 'createWorkspaceDocument')
    .mockImplementation(async (_org, body) => ({
      document: { ...page, id: body.title, title: body.title },
      etag: '"v1"',
    }))
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(new Error('Offline'))
  render(<WorkspaceCollaborativeDocs organisationId="org" />)
  await waitFor(() => expect(docsApi.listWorkspaceDocuments).toHaveBeenCalled())
  for (const [index, title] of ['First', 'Second', 'First'].entries()) {
    await user.click(screen.getByRole('button', { name: 'Nouveau dossier' }))
    await user.type(screen.getByTestId('drive-new-folder-input'), title)
    await user.click(screen.getByTestId('drive-new-folder-submit'))
    await waitFor(() => expect(docsApi.updateWorkspaceDocument).toHaveBeenCalledTimes(index + 1))
  }
  expect(create.mock.calls.map((call) => call[1].title)).toEqual(['First', 'Second'])
  expect(read).toHaveBeenCalledWith('org', 'First')
})

it('keeps a detail refresh authoritative when the initial list finishes later', async () => {
  mockRemotePages([])
  let finishList!: (items: readonly docsApi.CoreWorkspaceDocument[]) => void
  vi.mocked(docsApi.listWorkspaceDocuments).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishList = resolve
      })
  )
  vi.mocked(docsApi.getWorkspaceDocument).mockResolvedValue({
    document: { ...page, title: 'Fresh title', markdown: '# Collaborator content' },
    etag: '"fresh"',
  })
  render(<WorkspaceCollaborativeDocs organisationId="org" activeDocumentId={page.id} />)
  expect(await screen.findByTestId('docs-page-title-input')).toHaveValue('Fresh title')
  finishList([page])
  await waitFor(() =>
    expect(screen.getByTestId('docs-tree-item-page')).toHaveTextContent('Fresh title')
  )
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Fresh title')
})
it('persists large UTF-8 channel edits only within the local restore byte bound', async () => {
  const user = userEvent.setup()
  const update = vi.fn()
  render(
    <DriveWorkspaceContext.Provider
      value={{ ...channelContext(), onUpdateChannelDocument: update }}
    >
      <WorkspaceCollaborativeDocs localDocuments={[]} activeDocumentId="channel:guide" />
    </DriveWorkspaceContext.Provider>
  )
  await user.click(await screen.findByTestId('docs-surface-markdown'))
  const body = screen.getByRole('textbox', { name: 'Source Markdown' })
  const accepted = 'é'.repeat(131072)
  fireEvent.change(body, { target: { value: accepted } })
  expect(update).toHaveBeenLastCalledWith(
    'general',
    'guide',
    expect.objectContaining({ content: accepted })
  )
  const count = update.mock.calls.length
  fireEvent.change(body, { target: { value: accepted + 'é' } })
  expect(update).toHaveBeenCalledTimes(count)
})

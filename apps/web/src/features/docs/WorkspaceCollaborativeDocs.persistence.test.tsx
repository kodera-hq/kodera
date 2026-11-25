import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import '@/i18n'
import { WorkspaceCollaborativeDocs } from './WorkspaceCollaborativeDocs'
import { DriveWorkspaceContext, type DriveWorkspaceContextValue } from './DriveWorkspaceContext'
import { buildDocsOfflineDatabaseName } from './collabSession'
import { DOCUMENT_KIND_MARKERS, writeDriveCollectionRows } from './driveKinds'
import * as docsApi from './workspaceDocumentsApi'
import { createDefaultCollectionSchema } from './collectionSchema'
import { FOLDER_MARKDOWN_MARKER } from './DocsDriveExplorer'
import { getDocsDriveCopy } from './docsDriveMessages'
import { ApiProblem } from '@/api/client'
import { EspaceCanvasPanes, type EspaceCanvasPanesProps } from '../espace/EspaceCanvasPanes'
import type { Workspace } from '../workspace/workspace'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'

const persistence = vi.hoisted(() => ({
  instances: [] as {
    name: string
    doc: Y.Doc
    synced: () => void
    destroy: ReturnType<typeof vi.fn<() => void>>
  }[],
}))
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    entry: (typeof persistence.instances)[number]
    constructor(name: string, doc: Y.Doc) {
      this.entry = { name, doc, synced: () => undefined, destroy: vi.fn() }
      persistence.instances.push(this.entry)
    }
    on(_event: string, callback: () => void) {
      this.entry.synced = callback
    }
    destroy() {
      this.entry.destroy()
    }
  },
}))
vi.mock('../whiteboard/WhiteboardCanvas', () => ({
  WhiteboardCanvas: ({ doc }: { doc: Y.Doc }) => (
    <button data-testid="draw-stroke" onClick={() => doc.getArray('strokes').push(['new-stroke'])}>
      Draw
    </button>
  ),
}))
afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.removeItem('kodera.docs.pending-typed-creation')
  vi.unstubAllGlobals()
  persistence.instances.length = 0
})
const page = {
  id: 'page',
  title: 'Workspace page',
  markdown: '# Page',
  parentId: null,
  role: 'editor' as const,
  updatedAt: '',
}
function context(): DriveWorkspaceContextValue {
  return {
    workspaceId: 'demo:workspace',
    canvasMode: 'docs',
    store: {
      getTimeline: () => [],
      getRoomBoundary: () => 'ordinary',
    } as unknown as EspaceStoreLike,
    snapshot: {
      channels: new Map([['general', { state: 'resolved', roomId: '!general' }]]),
      rooms: [],
    } as unknown as EspaceSnapshot,
    channels: [{ id: 'general', kind: 'text', label: 'General' }],
    documents: [{ id: 'guide', channelId: 'general', title: 'Guide', content: '# Guide' }],
    activeChannelId: 'general',
    roomBoundary: 'ordinary',
    isConfidential: false,
    requestedDocument: undefined,
    onOpenChannel: vi.fn(),
    onOpenDirect: vi.fn(),
  }
}
it.each(['boundary', 'flag', 'detach'] as const)(
  'purges the source cache before teardown on protection via %s',
  async (transition) => {
    const deleted = vi.fn()
    vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: deleted })
    const user = userEvent.setup()
    let protectedRoom = false
    const value = context()
    const getRoomBoundary = () =>
      protectedRoom ? ('confidential-unavailable' as const) : ('ordinary' as const)
    const store = { ...value.store, getRoomBoundary } as unknown as EspaceStoreLike
    const panel = (contextValue: DriveWorkspaceContextValue) => (
      <DriveWorkspaceContext.Provider value={contextValue}>
        <WorkspaceCollaborativeDocs localDocuments={[page]} />
      </DriveWorkspaceContext.Provider>
    )
    const view = render(panel({ ...value, store }))
    await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
    await user.click(screen.getByTestId('drive-doc-card-channel:guide'))
    await waitFor(() =>
      expect(persistence.instances.some((entry) => entry.name.endsWith(':channel_guide'))).toBe(
        true
      )
    )
    const cached = persistence.instances.find((entry) => entry.name.endsWith(':channel_guide'))!
    if (transition === 'detach') {
      protectedRoom = true
      view.unmount()
    } else {
      protectedRoom = transition === 'boundary'
      view.rerender(
        panel({
          ...value,
          store,
          channels:
            transition === 'flag'
              ? [{ ...value.channels[0]!, is_confidential: true }]
              : value.channels,
          roomBoundary: 'confidential-unavailable',
          isConfidential: true,
        })
      )
    }
    expect(screen.queryByTestId('docs-page-title-input')).toBeNull()
    expect(deleted).toHaveBeenCalledWith(
      buildDocsOfflineDatabaseName('local-workspace', 'channel:guide')
    )
    expect(cached.destroy).toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalledWith(
      buildDocsOfflineDatabaseName('local-workspace', page.id)
    )
  }
)
it('keeps workspace cache through a confidential sidebar context while blocking plaintext actions', async () => {
  const deleted = vi.fn()
  vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: deleted })
  const value = {
    ...context(),
    roomBoundary: 'confidential-unavailable' as const,
    isConfidential: true,
  }
  const view = render(
    <DriveWorkspaceContext.Provider value={value}>
      <WorkspaceCollaborativeDocs activeDocumentId={page.id} localDocuments={[page]} />
    </DriveWorkspaceContext.Provider>
  )
  expect(await screen.findByTestId('docs-page-title-input')).toHaveAttribute('readonly')
  expect(screen.getByRole('button', { name: 'Nouvelle page' })).toBeDisabled()
  expect(deleted).not.toHaveBeenCalled()
  expect(persistence.instances[0]?.name).toBe(
    buildDocsOfflineDatabaseName('local-workspace', page.id)
  )
  view.unmount()
})
it('merges strokes drawn during hydration into the legacy local document without replacing it', async () => {
  vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: vi.fn() })
  const board = { ...page, markdown: DOCUMENT_KIND_MARKERS.whiteboard }
  render(
    <DriveWorkspaceContext.Provider value={context()}>
      <WorkspaceCollaborativeDocs activeDocumentId={page.id} localDocuments={[board]} />
    </DriveWorkspaceContext.Provider>
  )
  const draw = await screen.findByTestId('draw-stroke')
  const cached = persistence.instances[0]!
  expect(cached.name).toBe(buildDocsOfflineDatabaseName('local-workspace', page.id))
  fireEvent.click(draw)
  const old = new Y.Doc()
  old.getArray('strokes').push(['saved-stroke'])
  act(() => {
    Y.applyUpdate(cached.doc, Y.encodeStateAsUpdate(old))
    cached.synced()
  })
  expect(cached.doc.getArray('strokes').toArray()).toEqual(
    expect.arrayContaining(['new-stroke', 'saved-stroke'])
  )
  fireEvent.click(screen.getByTestId('draw-stroke'))
  expect(cached.doc.getArray('strokes').length).toBe(3)
  old.destroy()
})

it.each(['isConfidential', 'is_confidential', 'snapshot'] as const)(
  'purges an unmounted channel document on protection via %s',
  async (flag) => {
    const deleted = vi.fn()
    vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: deleted })
    const user = userEvent.setup()
    let value = context()
    let latestSnapshot = value.snapshot
    const listeners = new Set<() => void>()
    const unsubscribe = vi.fn()
    if (flag === 'snapshot') {
      latestSnapshot = {
        ...value.snapshot,
        rooms: [{ roomId: '!general', confidentiality: 'ordinary' }],
      } as unknown as EspaceSnapshot
      const store = {
        getTimeline: () => [],
        getSnapshot: () => latestSnapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
            unsubscribe()
          }
        },
      } as unknown as EspaceStoreLike
      value = { ...value, store, snapshot: latestSnapshot }
    }
    const channel = {
      id: 'general',
      kind: 'text' as const,
      name: 'General',
      template_key: null,
      topic: '',
      lifecycle: 'active' as const,
      is_confidential: false,
      room_state: 'ready' as const,
    }
    const props: EspaceCanvasPanesProps = {
      effectiveCanvasMode: 'docs',
      directRoomId: null,
      docsCanvasSlot: <WorkspaceCollaborativeDocs localDocuments={[page]} />,
      docsEverOpened: true,
      signedOut: false,
      onReconnect: undefined,
      activeChannel: channel,
      searchEntries: [...value.channels],
      activeStore: value.store,
      snapshot: value.snapshot,
      documents: value.documents,
      openStudioDocument: undefined,
      onOpenDocument: undefined,
      onSelectTextChannel: vi.fn(),
      onSelectDirect: vi.fn(),
      workspace: {
        organisation_id: 'org',
        id: 'workspace',
        categories: [],
        uncategorised_channels: [channel],
      } as unknown as Workspace,
      activeCall: null,
      callChannel: null,
      deviceSettings: null,
      onJoinAudioRoom: vi.fn(),
      onOpenCallStage: vi.fn(),
      roomBoundary: 'ordinary',
    }
    const view = render(<EspaceCanvasPanes {...props} />)
    await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
    await user.click(screen.getByTestId('drive-doc-card-channel:guide'))
    await waitFor(() =>
      expect(persistence.instances.some((entry) => entry.name.endsWith(':channel_guide'))).toBe(
        true
      )
    )
    view.rerender(
      <EspaceCanvasPanes
        {...props}
        effectiveCanvasMode="chat"
        directRoomId={flag === 'snapshot' ? '!direct' : null}
      />
    )
    deleted.mockClear()
    if (flag === 'snapshot') {
      expect(screen.queryByTestId('espace-inline-docs-canvas')).toBeNull()
      expect(value.store.getRoomBoundary).toBeUndefined()
      latestSnapshot = {
        ...value.snapshot,
        rooms: [{ roomId: '!general', confidentiality: 'confidential' }],
      } as unknown as EspaceSnapshot
      act(() => listeners.forEach((listener) => listener()))
    } else {
      const protectedChannel = { ...channel, [flag]: true }
      view.rerender(
        <EspaceCanvasPanes
          {...props}
          effectiveCanvasMode="chat"
          isConfidential
          activeChannel={protectedChannel}
          workspace={{ ...props.workspace, uncategorised_channels: [protectedChannel] }}
        />
      )
    }
    await waitFor(() =>
      expect(deleted).toHaveBeenCalledWith(
        buildDocsOfflineDatabaseName('local-workspace', 'channel:guide')
      )
    )
    expect(deleted).toHaveBeenCalledWith(buildDocsOfflineDatabaseName('org', 'channel:guide'))
    expect(screen.queryByTestId('espace-inline-docs-canvas')).toBeNull()
    expect(deleted).not.toHaveBeenCalledWith(
      buildDocsOfflineDatabaseName('local-workspace', page.id)
    )
    view.unmount()
    if (flag === 'snapshot') {
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(listeners.size).toBe(0)
    }
  }
)

function mockRemotePages(pages: readonly docsApi.CoreWorkspaceDocument[] = []) {
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue(pages)
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockRejectedValue(
    new Error('Unavailable')
  )
  return vi.spyOn(docsApi, 'getWorkspaceDocument').mockImplementation(async (_org, id) => ({
    document: pages.find((doc) => doc.id === id)!,
    etag: '"v1"',
  }))
}

it('remounts the same base after Core Collections without persisting Core rows into it', async () => {
  const user = userEvent.setup()
  const baseRow = {
    documentId: 'entry',
    values: { verified: { kind: 'checkbox' as const, value: false } },
    updatedAt: '',
  }
  const base = {
    ...page,
    markdown: writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, [baseRow]),
  }
  const child = { ...page, id: 'entry', parentId: page.id }
  mockRemotePages([base, child])
  const schema = { ...createDefaultCollectionSchema('fr'), id: 'core' }
  vi.spyOn(docsApi, 'listWorkspaceCollections').mockResolvedValue({
    collections: [schema],
    nextCursor: null,
    etag: null,
    hasMore: false,
  })
  vi.spyOn(docsApi, 'getWorkspaceCollection').mockResolvedValue({
    collection: schema,
    etag: '"v1"',
  })
  const query = vi.spyOn(docsApi, 'queryWorkspaceCollection').mockResolvedValue({
    rows: [
      { ...baseRow, values: { verified: { kind: 'checkbox', value: true } } },
      { ...baseRow, documentId: 'core-only' },
    ],
    nextCursor: null,
    hasMore: false,
  })
  const write = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockResolvedValue({ document: base, etag: '"v2"' })
  render(
    <WorkspaceCollaborativeDocs
      organisationId="org"
      activeDocumentId="page"
      initialSurface="core-collections"
    />
  )
  await waitFor(() => expect(query).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByTestId('collection-cell-entry-verified')).toBeChecked())
  await user.click(screen.getByTestId('docs-tree-item-page'))
  expect(await screen.findByTestId('collection-cell-entry-verified')).not.toBeChecked()
  await user.click(screen.getByTestId('collection-cell-entry-verified'))
  await waitFor(() => expect(write).toHaveBeenCalled())
  expect(write.mock.calls[0]?.[3].markdown).not.toContain('core-only')
  expect(screen.queryByTestId('collection-open-doc-core-only')).toBeNull()
})

it('creates a whiteboard only once on rapid double-click and stays busy through marker completion', async () => {
  mockRemotePages()
  const board = { ...page, id: 'board' }
  let finishCreate!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve
      })
  )
  let failMarker!: (reason: Error) => void
  const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        failMarker = reject
      })
  )
  const { container } = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  const button = screen.getByRole('button', { name: 'Nouveau tableau blanc' })
  act(() => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(create).toHaveBeenCalledOnce()
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByRole('button', { name: 'Nouvelle base' })).toBeEnabled()
  await act(async () => finishCreate({ document: board, etag: '"v1"' }))
  expect(patch).toHaveBeenCalledOnce()
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(create).toHaveBeenCalledOnce()
  await act(async () => failMarker(new Error('Offline')))
  expect(button).toBeEnabled()
  expect(button).not.toHaveAttribute('aria-busy')
  expect(container.querySelectorAll('[style]')).toHaveLength(0)
})

it.each([
  ['POST', false],
  ['POST', true],
  ['PATCH', false],
  ['PATCH', true],
] as const)(
  'shares typed creation across remounts during %s (marker failure: %s)',
  async (phase, markerFails) => {
    mockRemotePages()
    const board = { ...page, id: 'board' }
    const saved = {
      document: { ...board, markdown: DOCUMENT_KIND_MARKERS.whiteboard },
      etag: '"v2"',
    }
    let finishCreate!: (value: docsApi.WorkspaceDocumentWithEtag) => void
    const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve
        })
    )
    let finishMarker!: (value: docsApi.WorkspaceDocumentWithEtag) => void
    let failMarker!: (reason: Error) => void
    const patch = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishMarker = resolve
            failMarker = reject
          })
      )
      .mockResolvedValue(saved)
    const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
    fireEvent.click(within(first.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
    if (phase === 'PATCH') {
      await act(async () => finishCreate({ document: board, etag: '"v1"' }))
    }
    first.unmount()
    const second = render(<WorkspaceCollaborativeDocs organisationId="org" />)
    const button = within(second.container).getByRole('button', { name: 'Nouveau tableau blanc' })
    fireEvent.click(button)
    expect(create).toHaveBeenCalledOnce()
    if (phase === 'POST') {
      await act(async () => finishCreate({ document: board, etag: '"v1"' }))
    }
    expect(patch).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
      [expect.any(String), board.id],
    ])
    if (markerFails) {
      await act(async () => failMarker(new Error('Offline')))
      expect(button).toBeEnabled()
      expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
        [expect.any(String), board.id],
      ])
      vi.mocked(docsApi.getWorkspaceDocument).mockResolvedValue({ document: board, etag: '"v1"' })
      fireEvent.click(button)
      await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    } else {
      await act(async () => finishMarker(saved))
    }
    await waitFor(() =>
      expect(within(second.container).getByTestId('docs-tree-item-board')).toBeInTheDocument()
    )
    expect(create).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('kodera.docs.pending-typed-creation')).toBeNull()
  }
)

it.each([false, true])(
  'retains pending IDs across remounts only when storage was not cleared (write failure: %s)',
  async (writeFails) => {
    const read = mockRemotePages()
    const board = { ...page, id: 'board' }
    const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
      document: board,
      etag: '"v1"',
    })
    const patch = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue({
        document: { ...board, markdown: DOCUMENT_KIND_MARKERS.whiteboard },
        etag: '"v2"',
      })
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    if (writeFails)
      storageWrite.mockImplementation(() => {
        throw new Error('Storage unavailable')
      })
    const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
    fireEvent.click(within(first.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
    await waitFor(() => expect(storageWrite).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        within(first.container).getByRole('button', { name: 'Nouveau tableau blanc' })
      ).toBeEnabled()
    )
    expect(patch).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('kodera.docs.pending-typed-creation') === null).toBe(writeFails)
    first.unmount()
    storageWrite.mockRestore()
    if (!writeFails) sessionStorage.clear()
    read.mockResolvedValue({ document: board, etag: '"v1"' })
    const second = render(<WorkspaceCollaborativeDocs organisationId="org" />)
    fireEvent.click(within(second.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
    await waitFor(() =>
      expect(within(second.container).getByTestId('docs-tree-item-board')).toBeInTheDocument()
    )
    if (writeFails) expect(read).toHaveBeenCalledWith('org', board.id)
    else expect(read).not.toHaveBeenCalledWith('org', board.id)
    expect(patch.mock.calls[1]?.[1]).toBe(board.id)
    expect(create).toHaveBeenCalledTimes(writeFails ? 1 : 2)
    expect(sessionStorage.getItem('kodera.docs.pending-typed-creation')).toBeNull()
  }
)

it('clears failed-write fallback entries after another intent persists the full map', async () => {
  const read = mockRemotePages()
  const board = { ...page, id: 'board' }
  const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
    document: board,
    etag: '"v1"',
  })
  const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(new Error('Offline'))
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  fireEvent.click(screen.getByRole('button', { name: 'Nouveau tableau blanc' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Nouvelle base' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  first.unmount()
  sessionStorage.clear()
  read.mockResolvedValue({ document: board, etag: '"v1"' })
  render(<WorkspaceCollaborativeDocs organisationId="org" />)
  fireEvent.click(screen.getByRole('button', { name: 'Nouveau tableau blanc' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(3))
  expect(create).toHaveBeenCalledTimes(3)
})

it('excludes an unmounted joiner when the mounted origin becomes protected', async () => {
  mockRemotePages()
  let finishCreate!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  vi.spyOn(docsApi, 'createWorkspaceDocument').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve
      })
  )
  const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockResolvedValue({
    document: { ...page, markdown: DOCUMENT_KIND_MARKERS.whiteboard },
    etag: '"v2"',
  })
  const selected = vi.fn()
  const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  const second = render(
    <WorkspaceCollaborativeDocs organisationId="org" onActiveDocumentChange={selected} />
  )
  fireEvent.click(within(first.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
  fireEvent.click(within(second.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
  first.rerender(
    <WorkspaceCollaborativeDocs organisationId="org" roomBoundary="confidential-unavailable" />
  )
  second.unmount()
  await act(async () => finishCreate({ document: page, etag: '"v1"' }))
  expect(patch).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
})

it('retains a refused marker completion for recovery without another POST or PATCH', async () => {
  const read = mockRemotePages()
  const saved = {
    document: { ...page, markdown: DOCUMENT_KIND_MARKERS.whiteboard },
    etag: '"v2"',
  }
  const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
    document: page,
    etag: '"v1"',
  })
  let finishMarker!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishMarker = resolve
      })
  )
  const view = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  fireEvent.click(screen.getByRole('button', { name: 'Nouveau tableau blanc' }))
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  view.rerender(
    <WorkspaceCollaborativeDocs organisationId="org" roomBoundary="confidential-unavailable" />
  )
  await act(async () => finishMarker(saved))
  expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
    [expect.any(String), page.id],
  ])
  read.mockResolvedValue(saved)
  view.rerender(<WorkspaceCollaborativeDocs organisationId="org" />)
  fireEvent.click(screen.getByRole('button', { name: 'Nouveau tableau blanc' }))
  await screen.findByTestId('docs-tree-item-page')
  expect(create).toHaveBeenCalledOnce()
  expect(patch).toHaveBeenCalledOnce()
  expect(sessionStorage.getItem('kodera.docs.pending-typed-creation')).toBeNull()
})

it.each([
  ['whiteboard', 'POST', 'joiner'],
  ['whiteboard', 'PATCH', 'joiner'],
  ['whiteboard', 'POST', 'origin'],
  ['whiteboard', 'PATCH', 'origin'],
  ['folder', 'POST', 'joiner'],
  ['folder', 'PATCH', 'joiner'],
  ['folder', 'POST', 'origin'],
  ['folder', 'PATCH', 'origin'],
] as const)(
  'refuses the protected %s %s %s caller while the other caller completes',
  async (kind, phase, protectedCaller) => {
    mockRemotePages()
    const document = { ...page, id: 'created', title: 'Reports' }
    let finishCreate!: (value: docsApi.WorkspaceDocumentWithEtag) => void
    const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve
        })
    )
    let finishMarker!: (value: docsApi.WorkspaceDocumentWithEtag) => void
    const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMarker = resolve
        })
    )
    const originSelected = vi.fn()
    const joinerSelected = vi.fn()
    const first = render(
      <WorkspaceCollaborativeDocs organisationId="org" onActiveDocumentChange={originSelected} />
    )
    const second = render(
      <WorkspaceCollaborativeDocs organisationId="org" onActiveDocumentChange={joinerSelected} />
    )
    const startCreation = (container: HTMLElement) => {
      const panel = within(container)
      if (kind === 'whiteboard') {
        fireEvent.click(panel.getByRole('button', { name: 'Nouveau tableau blanc' }))
      } else {
        fireEvent.click(panel.getByTestId('drive-new-folder-btn'))
        fireEvent.change(panel.getByTestId('drive-new-folder-input'), {
          target: { value: document.title },
        })
        fireEvent.click(panel.getByTestId('drive-new-folder-submit'))
      }
    }
    startCreation(first.container)
    if (phase === 'PATCH') {
      await act(async () => finishCreate({ document, etag: '"v1"' }))
    }
    startCreation(second.container)
    expect(create).toHaveBeenCalledOnce()
    const protectedView = protectedCaller === 'joiner' ? second : first
    const protectedSelected = protectedCaller === 'joiner' ? joinerSelected : originSelected
    const permittedView = protectedCaller === 'joiner' ? first : second
    const permittedSelected = protectedCaller === 'joiner' ? originSelected : joinerSelected
    protectedView.rerender(
      <WorkspaceCollaborativeDocs
        organisationId="org"
        roomBoundary="confidential-unavailable"
        onActiveDocumentChange={protectedSelected}
      />
    )
    if (phase === 'POST') {
      await act(async () => finishCreate({ document, etag: '"v1"' }))
    }
    expect(patch).toHaveBeenCalledOnce()
    await act(async () =>
      finishMarker({
        document: {
          ...document,
          markdown: kind === 'folder' ? FOLDER_MARKDOWN_MARKER : DOCUMENT_KIND_MARKERS.whiteboard,
        },
        etag: '"v2"',
      })
    )
    expect(
      within(protectedView.container).getByText(getDocsDriveCopy('fr').shareRefused)
    ).toBeInTheDocument()
    expect(within(protectedView.container).queryByTestId('docs-tree-item-created')).toBeNull()
    expect(protectedSelected).not.toHaveBeenCalled()
    expect(
      within(permittedView.container).getByTestId('docs-tree-item-created')
    ).toBeInTheDocument()
    if (kind === 'whiteboard') expect(permittedSelected).toHaveBeenCalledWith(document.id)
    expect(create).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('kodera.docs.pending-typed-creation')).toBeNull()
  }
)

it.each(['base', 'whiteboard'] as const)(
  'recovers a pending %s from the refreshed list without erasing a distinct creation intent',
  async (kind) => {
    const user = userEvent.setup()
    const read = mockRemotePages()
    const created = { ...page, id: 'created', title: 'Pending document' }
    const other = { ...page, id: 'other', title: 'Other pending document' }
    const create = vi
      .spyOn(docsApi, 'createWorkspaceDocument')
      .mockResolvedValueOnce({ document: created, etag: '"v1"' })
      .mockResolvedValueOnce({ document: other, etag: '"v1"' })
    const patch = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockRejectedValue(new Error('Offline'))
    read.mockRejectedValueOnce(new Error('Offline'))
    const firstAction = kind === 'base' ? 'Nouvelle base' : 'Nouveau tableau blanc'
    const otherAction = kind === 'base' ? 'Nouveau tableau blanc' : 'Nouvelle base'
    const view = render(<WorkspaceCollaborativeDocs organisationId="org" />)
    await user.click(screen.getByRole('button', { name: firstAction }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: firstAction }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: otherAction }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
      [expect.any(String), created.id],
      [expect.any(String), other.id],
    ])
    view.unmount()

    // The successful POSTs are now in the list: sibling counts and generated titles have changed.
    vi.mocked(docsApi.listWorkspaceDocuments).mockResolvedValue([created, other])
    const serverDocs = new Map<string, docsApi.CoreWorkspaceDocument>(
      [created, other].map((doc) => [doc.id, doc])
    )
    read.mockImplementation(async (_org, id) => ({ document: serverDocs.get(id)!, etag: '"v1"' }))
    patch.mockImplementation(async (_org, id, _etag, body) => {
      const document = { ...serverDocs.get(id)!, ...body }
      serverDocs.set(id, document)
      return { document, etag: '"v2"' }
    })
    render(<WorkspaceCollaborativeDocs organisationId="org" />)
    await screen.findByTestId('docs-tree-item-created')
    expect(screen.getByTestId('docs-tree-item-other')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: firstAction }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(3))
    expect(read).toHaveBeenCalledWith('org', created.id)
    expect(patch.mock.calls[2]?.[1]).toBe(created.id)
    expect(patch.mock.calls[2]?.[3].markdown).toContain(DOCUMENT_KIND_MARKERS[kind])
    expect(create).toHaveBeenCalledTimes(2)
    expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
      [expect.any(String), other.id],
    ])
    await user.click(screen.getByTestId('docs-surface-drive'))
    await user.click(screen.getByRole('button', { name: otherAction }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(4))
    expect(patch.mock.calls[3]?.[1]).toBe(other.id)
    expect(create).toHaveBeenCalledTimes(2)
    expect(sessionStorage.getItem('kodera.docs.pending-typed-creation')).toBeNull()
  }
)

it('preserves another mounted panel’s pending creation when a marker finishes', async () => {
  const user = userEvent.setup()
  const read = mockRemotePages()
  const base = { ...page, id: 'base' }
  const board = { ...page, id: 'board' }
  const create = vi
    .spyOn(docsApi, 'createWorkspaceDocument')
    .mockResolvedValueOnce({ document: base, etag: '"v1"' })
    .mockResolvedValueOnce({ document: board, etag: '"v1"' })
  let finishBase!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  const patch = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBase = resolve
        })
    )
    .mockRejectedValue(new Error('Offline'))
  const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  const second = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  await user.click(within(first.container).getByRole('button', { name: 'Nouvelle base' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  await user.click(within(second.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  read.mockResolvedValue({
    document: { ...base, markdown: DOCUMENT_KIND_MARKERS.base },
    etag: '"v2"',
  })
  await act(async () =>
    finishBase({
      document: { ...base, markdown: DOCUMENT_KIND_MARKERS.base },
      etag: '"v2"',
    })
  )
  expect(JSON.parse(sessionStorage.getItem('kodera.docs.pending-typed-creation')!)).toEqual([
    [expect.any(String), board.id],
  ])
  second.unmount()
  read.mockResolvedValue({ document: board, etag: '"v1"' })
  patch.mockResolvedValue({
    document: { ...board, markdown: DOCUMENT_KIND_MARKERS.whiteboard },
    etag: '"v2"',
  })
  await user.click(within(first.container).getByTestId('docs-surface-drive'))
  await user.click(within(first.container).getByRole('button', { name: 'Nouveau tableau blanc' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(3))
  expect(create).toHaveBeenCalledTimes(2)
  expect(patch.mock.calls[2]?.[1]).toBe(board.id)
})

it('replaces the unmarked folder from the refreshed list during recovery', async () => {
  const user = userEvent.setup()
  const read = mockRemotePages()
  const folder = { ...page, id: 'folder', title: 'Reports' }
  const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
    document: folder,
    etag: '"v1"',
  })
  const patch = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(new Error('Offline'))
  const createFolder = async () => {
    await user.click(screen.getByTestId('drive-new-folder-btn'))
    await user.type(screen.getByTestId('drive-new-folder-input'), folder.title)
    await user.click(screen.getByTestId('drive-new-folder-submit'))
  }
  const first = render(<WorkspaceCollaborativeDocs organisationId="org" />)
  await createFolder()
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  first.unmount()
  vi.mocked(docsApi.listWorkspaceDocuments).mockResolvedValue([folder])
  read.mockResolvedValue({ document: folder, etag: '"v1"' })
  patch.mockResolvedValue({
    document: { ...folder, markdown: FOLDER_MARKDOWN_MARKER },
    etag: '"v2"',
  })
  render(<WorkspaceCollaborativeDocs organisationId="org" />)
  await screen.findByTestId('docs-tree-item-folder')
  await createFolder()
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  expect(create).toHaveBeenCalledOnce()
  await user.click(screen.getByTestId('docs-tree-item-folder'))
  expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
  expect(screen.queryByTestId('docs-page-title-input')).toBeNull()
})

it('revalidates the missing first item reopened from channel attachments before clearing its 404', async () => {
  const user = userEvent.setup()
  const read = mockRemotePages([page])
  read.mockRejectedValue(new ApiProblem({ type: null, status: 404, title: 'Not Found' }))
  const value = context()
  render(
    <DriveWorkspaceContext.Provider
      value={{
        ...value,
        documents: [
          {
            id: `workspace-page:${page.id}`,
            channelId: '',
            title: page.title,
            content: page.markdown,
          },
        ],
      }}
    >
      <WorkspaceCollaborativeDocs organisationId="org" activeDocumentId={page.id} />
    </DriveWorkspaceContext.Provider>
  )
  await screen.findByText('Document introuvable ou inaccessible')
  await screen.findByTestId('docs-tree-item-page')
  await user.click(screen.getByTestId('docs-surface-drive'))
  await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
  const readsBeforeReopen = read.mock.calls.length
  let finishRead!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRead = resolve
      })
  )
  await user.click(screen.getByTestId('drive-doc-card-channel:workspace-page:page'))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(readsBeforeReopen + 1))
  expect(screen.getByText('Document introuvable ou inaccessible')).toBeInTheDocument()
  await act(async () => finishRead({ document: page, etag: '"v2"' }))
  expect(await screen.findByTestId('docs-page-title-input')).toHaveValue(page.title)
  expect(screen.queryByText('Document introuvable ou inaccessible')).toBeNull()
})

it.each(['files', 'root', 'breadcrumb'] as const)(
  'opens Drive root after a missing shared document via %s',
  async (action) => {
    const user = userEvent.setup()
    const read = mockRemotePages(action === 'breadcrumb' ? [page] : [])
    read.mockRejectedValue(new ApiProblem({ type: null, status: 404, title: 'Not Found' }))
    const value = context()
    const panel = (navigationRequestKey: number) => (
      <DriveWorkspaceContext.Provider value={{ ...value, navigationRequestKey }}>
        <WorkspaceCollaborativeDocs
          organisationId="org"
          activeDocumentId={action === 'breadcrumb' ? page.id : 'missing'}
        />
      </DriveWorkspaceContext.Provider>
    )
    const view = render(panel(1))
    await screen.findByText('Document introuvable ou inaccessible')
    if (action === 'files') view.rerender(panel(2))
    else if (action === 'root') await user.click(screen.getByTestId('docs-surface-drive'))
    else await user.click(screen.getByTestId('docs-breadcrumb-drive-root'))
    expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
    expect(screen.queryByText('Document introuvable ou inaccessible')).toBeNull()
  }
)

it.each(['root', 'files'] as const)(
  'revalidates the missing first tree item after resetting to Drive via %s',
  async (action) => {
    const user = userEvent.setup()
    const read = mockRemotePages([page])
    read.mockRejectedValue(new ApiProblem({ type: null, status: 404, title: 'Not Found' }))
    const value = context()
    const panel = (canvasMode: 'docs' | 'files') => (
      <DriveWorkspaceContext.Provider value={{ ...value, canvasMode }}>
        <WorkspaceCollaborativeDocs organisationId="org" activeDocumentId={page.id} />
      </DriveWorkspaceContext.Provider>
    )
    const view = render(panel('docs'))
    await screen.findByText('Document introuvable ou inaccessible')
    await screen.findByTestId('docs-tree-item-page')
    if (action === 'root') await user.click(screen.getByTestId('docs-surface-drive'))
    else view.rerender(panel('files'))
    expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
    expect(screen.queryByText('Document introuvable ou inaccessible')).toBeNull()
    const readsBeforeReopen = read.mock.calls.length
    await user.click(screen.getByTestId('drive-doc-card-page'))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(readsBeforeReopen + 1))
    expect(read).toHaveBeenLastCalledWith('org', page.id, expect.any(AbortSignal))
    expect(await screen.findByText('Document introuvable ou inaccessible')).toBeInTheDocument()
    expect(screen.queryByTestId('docs-page-title-input')).toBeNull()
    expect(screen.queryByTestId('docs-drive-explorer')).toBeNull()
  }
)
